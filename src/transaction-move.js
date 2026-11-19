export { moveTargets as expandMoveRows } from "../public/ui-model.js";

export function normalizeMoveName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

export function matchMoveWallet(name, wallets) {
  if (!name) return { wallet: null, ambiguous: false };
  const matches = wallets.filter((wallet) => normalizeMoveName(wallet.name) === normalizeMoveName(name));
  return { wallet: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}
