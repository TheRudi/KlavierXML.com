<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$candidates = [
  getenv('KLAVIERXML_CONFIG') ?: '',
  '/Library/WebServer/KlavierXML-data/config.local.php',
  __DIR__ . '/config.local.php',
];
$configFile = '';
foreach ($candidates as $candidate) {
  if ($candidate !== '' && is_file($candidate)) {
    $configFile = $candidate;
    break;
  }
}
if (!is_file($configFile)) {
  http_response_code(500);
  echo json_encode(['error' => 'Server config missing (api/config.local.php).']);
  exit;
}

/** @var array $config */
$config = require $configFile;
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
  $pdo = db_connect($config);
  ensure_schema($pdo);
  ensure_storage($config);

  if ($method === 'GET') {
    handle_list($pdo, $config);
  } elseif ($method === 'POST') {
    handle_upload($pdo, $config);
  } elseif ($method === 'DELETE') {
    handle_delete($pdo, $config);
  } else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
  }
} catch (Throwable $e) {
  http_response_code(500);
  echo json_encode(['error' => $e->getMessage()]);
}

function db_connect(array $config): PDO
{
  $db = $config['db'];
  $dsn = sprintf(
    'pgsql:host=%s;port=%d;dbname=%s',
    $db['host'],
    (int) $db['port'],
    $db['name']
  );
  $pdo = new PDO($dsn, $db['user'], $db['pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
  return $pdo;
}

function ensure_schema(PDO $pdo): void
{
  $pdo->exec(
    'CREATE TABLE IF NOT EXISTS exchange_scores (
      id text PRIMARY KEY,
      title text NOT NULL,
      composer text NOT NULL,
      credit text,
      filename text NOT NULL,
      format text NOT NULL DEFAULT \'mxl\',
      bytes integer NOT NULL DEFAULT 0,
      added date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')::date,
      license text,
      storage_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\')
    )'
  );
}

function ensure_storage(array $config): void
{
  $dir = $config['storage_dir'];
  if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
    throw new RuntimeException('Could not create storage directory.');
  }
  if (!is_writable($dir)) {
    throw new RuntimeException('Storage directory is not writable.');
  }
}

function storage_path_for(string $id): string
{
  return 'files/' . $id . '.mxl';
}

function handle_list(PDO $pdo, array $config): void
{
  $limit = (int) ($config['max_files'] ?? 100);
  $stmt = $pdo->prepare(
    'SELECT id, title, composer, credit, filename, format, bytes, added, license, storage_path
     FROM exchange_scores
     ORDER BY created_at DESC
     LIMIT ?'
  );
  $stmt->bindValue(1, $limit, PDO::PARAM_INT);
  $stmt->execute();
  $rows = $stmt->fetchAll();
  foreach ($rows as &$row) {
    $row['bytes'] = (int) $row['bytes'];
    if (!empty($row['added']) && is_string($row['added'])) {
      $row['added'] = substr($row['added'], 0, 10);
    }
  }
  echo json_encode(['scores' => $rows], JSON_UNESCAPED_UNICODE);
}

function handle_upload(PDO $pdo, array $config): void
{
  $maxFiles = (int) ($config['max_files'] ?? 100);
  $maxBytes = (int) ($config['max_mxl_bytes'] ?? 100 * 1024);

  $count = (int) $pdo->query('SELECT COUNT(*) FROM exchange_scores')->fetchColumn();
  if ($count >= $maxFiles) {
    http_response_code(400);
    echo json_encode(['error' => "The shared exchange already has {$maxFiles} scores. Remove one before uploading another."]);
    return;
  }

  $id = trim((string) ($_POST['id'] ?? ''));
  $title = trim((string) ($_POST['title'] ?? ''));
  $composer = trim((string) ($_POST['composer'] ?? ''));
  $credit = trim((string) ($_POST['credit'] ?? ''));
  $filename = trim((string) ($_POST['filename'] ?? ''));
  $license = trim((string) ($_POST['license'] ?? ''));
  $added = trim((string) ($_POST['added'] ?? date('Y-m-d')));

  if ($id === '' || $title === '' || $composer === '' || $filename === '') {
    http_response_code(400);
    echo json_encode(['error' => 'Missing score metadata.']);
    return;
  }
  if (!preg_match('/^[a-zA-Z0-9._-]{1,120}$/', $id)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid score id.']);
    return;
  }

  $exists = $pdo->prepare('SELECT 1 FROM exchange_scores WHERE id = ?');
  $exists->execute([$id]);
  if ($exists->fetchColumn()) {
    $stmt = $pdo->prepare(
      'SELECT id, title, composer, credit, filename, format, bytes, added, license, storage_path
       FROM exchange_scores ORDER BY created_at DESC LIMIT ?'
    );
    $stmt->bindValue(1, $maxFiles, PDO::PARAM_INT);
    $stmt->execute();
    echo json_encode(['ok' => true, 'scores' => $stmt->fetchAll()], JSON_UNESCAPED_UNICODE);
    return;
  }

  if (!isset($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing score file.']);
    return;
  }

  $size = (int) $_FILES['file']['size'];
  if ($size <= 0 || $size > $maxBytes) {
    http_response_code(400);
    echo json_encode(['error' => 'Score file is too large for the exchange.']);
    return;
  }

  $relPath = storage_path_for($id);
  $absPath = rtrim($config['storage_dir'], '/') . '/' . $id . '.mxl';
  if (!move_uploaded_file($_FILES['file']['tmp_name'], $absPath)) {
    throw new RuntimeException('Could not store the score file.');
  }
  @chmod($absPath, 0664);

  $row = [
    'id' => $id,
    'title' => $title,
    'composer' => $composer,
    'credit' => $credit,
    'filename' => $filename,
    'format' => 'mxl',
    'bytes' => $size,
    'added' => $added,
    'license' => $license,
    'storage_path' => $relPath,
  ];

  try {
    $ins = $pdo->prepare(
      'INSERT INTO exchange_scores
        (id, title, composer, credit, filename, format, bytes, added, license, storage_path)
       VALUES
        (:id, :title, :composer, :credit, :filename, :format, :bytes, :added, :license, :storage_path)'
    );
    $ins->execute($row);
  } catch (Throwable $e) {
    @unlink($absPath);
    throw $e;
  }

  echo json_encode(['ok' => true, 'score' => $row], JSON_UNESCAPED_UNICODE);
}

function handle_delete(PDO $pdo, array $config): void
{
  $password = $_SERVER['HTTP_X_ADMIN_PASSWORD'] ?? ($_GET['password'] ?? '');
  if (!hash_equals((string) $config['remove_password'], (string) $password)) {
    http_response_code(403);
    echo json_encode(['error' => 'Wrong remove password.']);
    return;
  }

  $id = trim((string) ($_GET['id'] ?? ''));
  if ($id === '' || !preg_match('/^[a-zA-Z0-9._-]{1,120}$/', $id)) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing score id.']);
    return;
  }

  $sel = $pdo->prepare('SELECT storage_path FROM exchange_scores WHERE id = ?');
  $sel->execute([$id]);
  $path = $sel->fetchColumn();
  if (!$path) {
    http_response_code(404);
    echo json_encode(['error' => 'Score not found.']);
    return;
  }

  $del = $pdo->prepare('DELETE FROM exchange_scores WHERE id = ?');
  $del->execute([$id]);

  $absPath = rtrim($config['storage_dir'], '/') . '/' . $id . '.mxl';
  if (is_file($absPath)) {
    @unlink($absPath);
  }

  echo json_encode(['ok' => true]);
}
