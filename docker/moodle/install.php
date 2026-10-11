<?php
// Invoke Moodle's own installer without putting the password in process arguments.
if (PHP_SAPI !== 'cli') {
    exit(1);
}

function moodle_lab_required(string $name): string {
    $value = getenv($name);
    if ($value === false || $value === '') {
        fwrite(STDERR, "Missing environment variable: {$name}\n");
        exit(1);
    }
    return $value;
}

$dbpassword = moodle_lab_required('MOODLE_LAB_DB_PASSWORD');
$adminpassword = moodle_lab_required('MOODLE_LAB_ADMIN_PASSWORD');
$quotedpassword = "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $dbpassword) . "'";
$connection = @pg_connect("host=postgres port=5432 dbname=moodle user=moodle password={$quotedpassword} connect_timeout=10");
if (!$connection) {
    fwrite(STDERR, "Could not connect to the local Moodle database.\n");
    exit(1);
}
$result = pg_query($connection, "SELECT to_regclass('public.mdl_config') IS NOT NULL AS has_config");
if (pg_fetch_result($result, 0, 'has_config') === 't') {
    $version = pg_query($connection, "SELECT value FROM mdl_config WHERE name = 'version'");
    if (pg_num_rows($version) === 1) {
        fwrite(STDOUT, "Moodle is already installed. No data or admin password changed.\n");
        exit(0);
    }
    fwrite(STDERR, "The database contains an incomplete installation. Preserve its data and inspect the installer logs.\n");
    exit(1);
}
pg_close($connection);

$argv = [
    '/var/www/html/admin/cli/install_database.php',
    '--agree-license',
    '--lang=ru',
    '--adminuser=' . (getenv('MOODLE_LAB_ADMIN_USER') ?: 'admin'),
    '--adminpass=' . $adminpassword,
    '--adminemail=' . (getenv('MOODLE_LAB_ADMIN_EMAIL') ?: 'admin@example.invalid'),
    '--fullname=' . (getenv('MOODLE_LAB_FULLNAME') ?: 'Управление ЭО на веб-платформе — локальный стенд'),
    '--shortname=' . (getenv('MOODLE_LAB_SHORTNAME') ?: 'EO Web Lab'),
    '--summary=Изолированный локальный Moodle для учебных тестов. LTI пока не подключён.',
];
$argc = count($argv);
$_SERVER['argv'] = $argv;
$_SERVER['argc'] = $argc;
require $argv[0];
