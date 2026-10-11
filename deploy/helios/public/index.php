<?php
declare(strict_types=1);

// Fixed backend: this gateway must never accept an upstream URL from the request.
const RAG_PREFIX = '/~s507353/moodle-lti-rag';
const RAG_BACKEND = 'http://127.0.0.1:30353';
const RAG_MAX_BODY = 131072;
const RAG_MAX_RESPONSE = 2097152;

function gatewayError(int $status, string $code): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    exit;
}

$uri = $_SERVER['REQUEST_URI'] ?? '';
$requestPath = explode('?', $uri, 2)[0];
if (
    strlen($uri) > 16384 ||
    preg_match('/[\x00-\x20\x7f]/', $uri) ||
    ($requestPath !== RAG_PREFIX && !str_starts_with($requestPath, RAG_PREFIX . '/'))
) {
    gatewayError(400, 'invalid_path');
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
    header('Allow: GET, HEAD, POST');
    gatewayError(405, 'method_not_allowed');
}
$body = file_get_contents('php://input', false, null, 0, RAG_MAX_BODY + 1);
if ($body === false || strlen($body) > RAG_MAX_BODY) {
    gatewayError(413, 'request_too_large');
}

$headers = ['Host: se.ifmo.ru', 'Connection: close', 'Accept-Encoding: identity'];
foreach ([
    'HTTP_ACCEPT' => 'Accept',
    'CONTENT_TYPE' => 'Content-Type',
    'HTTP_COOKIE' => 'Cookie',
    'HTTP_ORIGIN' => 'Origin',
    'HTTP_SEC_FETCH_SITE' => 'Sec-Fetch-Site',
    'HTTP_X_CSRF_TOKEN' => 'X-CSRF-Token',
] as $key => $name) {
    $value = $_SERVER[$key] ?? null;
    if (is_string($value)) {
        if (preg_match('/[\r\n]/', $value)) {
            gatewayError(400, 'invalid_header');
        }
        $headers[] = $name . ': ' . $value;
    }
}
$context = stream_context_create(['http' => [
    'method' => $method,
    'header' => $headers,
    'content' => $body,
    'protocol_version' => 1.1,
    'follow_location' => 0,
    'ignore_errors' => true,
    'timeout' => 30.0,
]]);
$upstream = @fopen(RAG_BACKEND . $uri, 'rb', false, $context);
if ($upstream === false) {
    gatewayError(502, 'backend_unavailable');
}
$responseBody = stream_get_contents($upstream, RAG_MAX_RESPONSE + 1);
$metadata = stream_get_meta_data($upstream);
fclose($upstream);
if ($metadata['timed_out'] ?? false) {
    gatewayError(504, 'backend_timeout');
}
if ($responseBody === false || strlen($responseBody) > RAG_MAX_RESPONSE) {
    gatewayError(502, 'invalid_backend_response');
}
$responseHeaders = $metadata['wrapper_data'] ?? [];
$status = null;
foreach ($responseHeaders as $line) {
    if (preg_match('/^HTTP\/[0-9.]+ ([1-5][0-9]{2})\b/', $line, $match)) {
        $status = (int) $match[1];
    }
}
if ($status === null) {
    gatewayError(502, 'invalid_backend_response');
}
http_response_code($status);
foreach ($responseHeaders as $line) {
    $name = strtolower(explode(':', $line, 2)[0]);
    if (in_array($name, [
        'content-type', 'location', 'set-cookie', 'cache-control',
        'content-security-policy', 'referrer-policy', 'x-frame-options',
        'permissions-policy', 'x-content-type-options', 'cross-origin-opener-policy',
        'cross-origin-resource-policy', 'origin-agent-cluster', 'x-dns-prefetch-control',
        'x-download-options', 'x-permitted-cross-domain-policies', 'x-xss-protection',
        'etag', 'last-modified', 'vary',
    ], true)) {
        header($line, false);
    }
}
if ($method !== 'HEAD') {
    echo $responseBody;
}
