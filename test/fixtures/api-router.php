<?php
$path = (string)parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (!str_starts_with($path, '/api/')) {
    http_response_code(404);
    exit;
}
$_GET['path'] = substr($path, 5);
require __DIR__ . '/api.php';
