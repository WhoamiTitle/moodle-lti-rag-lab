<?php
// Local, isolated Moodle. Credentials come from the ignored .env.moodle file.
unset($CFG);
global $CFG;
$CFG = new stdClass();

$laburl = getenv('MOODLE_LAB_URL') ?: 'http://localhost:8000';
$laburlparts = parse_url($laburl);
if (!$laburlparts || ($laburlparts['scheme'] ?? '') !== 'http'
        || !in_array($laburlparts['host'] ?? '', ['localhost', '127.0.0.1'], true)
        || !empty($laburlparts['user']) || !empty($laburlparts['pass'])
        || !empty($laburlparts['query']) || !empty($laburlparts['fragment'])
        || !in_array($laburlparts['path'] ?? '', ['', '/'], true)) {
    throw new RuntimeException('MOODLE_LAB_URL must be a local HTTP origin without a subpath.');
}

$CFG->dbtype = 'pgsql';
$CFG->dblibrary = 'native';
$CFG->dbhost = 'postgres';
$CFG->dbname = 'moodle';
$CFG->dbuser = 'moodle';
$CFG->dbpass = getenv('MOODLE_LAB_DB_PASSWORD');
if (!$CFG->dbpass) {
    throw new RuntimeException('MOODLE_LAB_DB_PASSWORD is required.');
}
$CFG->prefix = 'mdl_';
$CFG->dboptions = ['dbpersist' => false, 'dbsocket' => false, 'dbport' => '5432'];
$CFG->wwwroot = rtrim($laburl, '/');
$CFG->dataroot = '/var/www/moodledata';
$CFG->admin = 'admin';
$CFG->directorypermissions = 02770;
$CFG->sessioncookie = 'EOWebLab';
$CFG->routerconfigured = true;
$CFG->noemailever = true;

require_once(__DIR__ . '/lib/setup.php');
