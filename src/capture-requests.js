import crypto from "node:crypto";

export function captureKey(value) {
  if (!value) return null;
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(String(value))) {
    throw Object.assign(new Error("Identificador de envio inválido."), { status: 400 });
  }
  return String(value);
}

export function captureFingerprint(operation, payload, file) {
  const content = file
    ? [crypto.createHash("sha256").update(file.buffer).digest("hex"), file.mimeType, file.originalName].join("|")
    : JSON.stringify(payload);
  return crypto.createHash("sha256").update(operation + "|" + content).digest("hex");
}

export function captureMetadata(result, key) {
  return {
    ...(result.capture || { transactionIds: [] }),
    requestId: key,
    messageId: result.messages?.at(-1)?.id || null
  };
}

export async function executeCapture(connection, { userId, controlId, key, operation, fingerprint }, action, replay) {
  await connection.beginTransaction();
  try {
    if (key) {
      try {
        await connection.execute("INSERT INTO capture_requests (user_id, control_id, request_key, operation, fingerprint) VALUES (?, ?, ?, ?, ?)", [userId, controlId, key, operation, fingerprint]);
      } catch (error) {
        if (error.code !== "ER_DUP_ENTRY") throw error;
        await connection.rollback();
        const [rows] = await connection.execute("SELECT operation, fingerprint, capture_data FROM capture_requests WHERE user_id = ? AND control_id = ? AND request_key = ?", [userId, controlId, key]);
        const previous = rows[0];
        if (!previous || previous.operation !== operation || previous.fingerprint !== fingerprint) {
          throw Object.assign(new Error("Este identificador já pertence a outro envio."), { status: 409 });
        }
        if (!previous.capture_data) throw Object.assign(new Error("Este envio ainda está em processamento. Tente novamente em instantes."), { status: 409 });
        return { ...await replay(), capture: { ...JSON.parse(previous.capture_data), replayed: true } };
      }
    }
    const result = await action();
    const capture = captureMetadata(result, key);
    if (operation === "manual") capture.messageId = null;
    if (key) await connection.execute("UPDATE capture_requests SET capture_data = ? WHERE user_id = ? AND control_id = ? AND request_key = ?", [JSON.stringify(capture), userId, controlId, key]);
    await connection.commit();
    return { ...result, capture };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
