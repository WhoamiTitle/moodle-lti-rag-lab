<?php
// CLI-only setup of our synthetic local lab, using Moodle APIs, never grade writes.
if (PHP_SAPI !== 'cli' || posix_getpwuid(posix_geteuid())['name'] !== 'www-data') {
    throw new RuntimeException('Run this helper as www-data using scripts/moodle.sh.');
}
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
if ($CFG->wwwroot !== 'http://localhost:8000') {
    throw new RuntimeException('This helper is restricted to http://localhost:8000.');
}
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
require_once($CFG->libdir . '/gradelib.php');
\core\session\manager::set_user(get_admin());
$PAGE->set_context(context_system::instance());

const LAB_COURSE = 'rag-lti-local-course-v1';
const LAB_ACTIVITY = 'rag-lti-local-activity-v1';
const LAB_TOOL = 'RAG · LTI 1.3 (локальный стенд)';
const LAB_LAUNCH = 'http://localhost:3000/lti/launch';

function lab_course() {
    global $DB;
    return $DB->get_record('course', ['idnumber' => LAB_COURSE]);
}

function lab_tool($courseid) {
    global $DB;
    return $DB->get_record('lti_types', ['course' => $courseid, 'name' => LAB_TOOL]);
}

function prepare_lab(array $credentials): void {
    global $DB, $CFG;
    foreach (['a', 'b'] as $suffix) {
        if (!preg_match('/^Lti![a-f0-9]{48}Aa1$/', $credentials[$suffix] ?? '')) {
            throw new RuntimeException('Missing or invalid private student credentials.');
        }
    }
    $transaction = $DB->start_delegated_transaction();
    $course = lab_course();
    if (!$course) {
        $course = create_course((object)[
            'fullname' => 'RAG-рекомендательная система · лабораторная LTI',
            'shortname' => 'RAG-LTI-LAB',
            'idnumber' => LAB_COURSE,
            'category' => $DB->get_field('course_categories', 'id', [], IGNORE_MULTIPLE),
            'format' => 'topics',
            'visible' => 1,
            'lang' => 'ru',
        ]);
    }
    if ($course->shortname !== 'RAG-LTI-LAB') {
        throw new RuntimeException('Course marker is already used by a different course.');
    }
    $context = context_course::instance($course->id);
    $studentrole = $DB->get_record('role', ['shortname' => 'student'], '*', MUST_EXIST);
    $manual = enrol_get_plugin('manual');
    $instances = enrol_get_instances($course->id, true);
    $enrolment = null;
    foreach ($instances as $instance) {
        if ($instance->enrol === 'manual') {
            $enrolment = $instance;
            break;
        }
    }
    if (!$enrolment) {
        $enrolmentid = $manual->add_instance($course);
        $enrolment = $DB->get_record('enrol', ['id' => $enrolmentid], '*', MUST_EXIST);
    }
    foreach (['a', 'b'] as $suffix) {
        $username = 'lti_student_' . $suffix;
        $marker = 'rag-lti-local-student-' . $suffix;
        $user = \core\user::get_user_by_username($username);
        if (!$user) {
            $userid = \core\user::create_user((object)[
                'username' => $username,
                'password' => $credentials[$suffix],
                'auth' => 'manual',
                'confirmed' => 1,
                'firstname' => 'Студент ' . strtoupper($suffix),
                'lastname' => '(LTI-тест)',
                'email' => $username . '@example.invalid',
                'idnumber' => $marker,
                'mnethostid' => $CFG->mnet_localhost_id,
                'lang' => 'ru',
            ]);
            $user = \core\user::get_user($userid);
        }
        if ($user->idnumber !== $marker || $user->deleted || $user->suspended || is_siteadmin($user)
                || !validate_internal_user_password($user, $credentials[$suffix])) {
            throw new RuntimeException('Existing test account differs; it was not overwritten.');
        }
        foreach (get_user_roles($context, $user->id) as $role) {
            if ($role->roleid != $studentrole->id) {
                throw new RuntimeException('Test account has a non-student role; no roles were removed.');
            }
        }
        $manual->enrol_user($enrolment, $user->id, $studentrole->id);
    }
    $type = lab_tool($course->id);
    if (!$type) {
        // "state" is Moodle's required external field, not application storage.
        $typeid = lti_add_type((object)[
            'course' => $course->id,
            'state' => LTI_TOOL_STATE_PENDING,
        ], (object)[
            'lti_typename' => LAB_TOOL,
            'lti_toolurl' => LAB_LAUNCH,
            'lti_ltiversion' => LTI_VERSION_1P3,
            'lti_keytype' => LTI_RSA_KEY,
            'lti_initiatelogin' => 'http://localhost:3000/lti/login',
            'lti_redirectionuris' => LAB_LAUNCH,
            'lti_coursevisible' => LTI_COURSEVISIBLE_ACTIVITYCHOOSER,
            'lti_launchcontainer' => LTI_LAUNCH_CONTAINER_WINDOW,
            'lti_contentitem' => 0,
            'lti_sendname' => LTI_SETTING_ALWAYS,
            'lti_sendemailaddr' => LTI_SETTING_NEVER,
            'lti_acceptgrades' => LTI_SETTING_ALWAYS,
            // Existing column + scores only; no right to create gradebook columns.
            'ltiservice_gradesynchronization' => 1,
            'ltiservice_memberships' => 0,
            'ltiservice_toolsettings' => 0,
        ]);
        $type = $DB->get_record('lti_types', ['id' => $typeid], '*', MUST_EXIST);
    }
    if ($type->baseurl !== LAB_LAUNCH || $type->ltiversion !== LTI_VERSION_1P3) {
        throw new RuntimeException('Existing tool differs; registration was not replaced.');
    }
    $cm = $DB->get_record('course_modules', ['course' => $course->id, 'idnumber' => LAB_ACTIVITY]);
    if (!$cm) {
        add_moduleinfo((object)[
            'modulename' => 'lti',
            'module' => $DB->get_field('modules', 'id', ['name' => 'lti'], MUST_EXIST),
            'name' => 'Тренажёр RAG · 3 задания / 10 баллов',
            'intro' => '<p>Три коротких ответа по RAG. Веса: 3/3/4. В журнал отправляется последняя завершённая попытка.</p>',
            'introformat' => FORMAT_HTML,
            'section' => 0,
            'visible' => 1,
            'cmidnumber' => LAB_ACTIVITY,
            'typeid' => $type->id,
            'launchcontainer' => LTI_LAUNCH_CONTAINER_WINDOW,
            'grade' => 10,
            'instructorchoiceacceptgrades' => LTI_SETTING_ALWAYS,
            'instructorchoicesendname' => LTI_SETTING_ALWAYS,
            'instructorchoicesendemailaddr' => LTI_SETTING_NEVER,
        ], $course);
    }
    $transaction->allow_commit();
}

function prepare_instructor(array $credentials): void {
    global $DB, $CFG;
    if (!preg_match('/^Lti![a-f0-9]{48}Aa1$/', $credentials['password'] ?? '')) {
        throw new RuntimeException('Missing or invalid private instructor credentials.');
    }
    $course = lab_course();
    if (!$course || $course->shortname !== 'RAG-LTI-LAB') {
        throw new RuntimeException('Prepare our synthetic local course first.');
    }
    $transaction = $DB->start_delegated_transaction();
    $username = 'lti_instructor';
    $marker = 'rag-lti-local-instructor-v1';
    $user = \core\user::get_user_by_username($username);
    if (!$user) {
        $userid = \core\user::create_user((object)[
            'username' => $username,
            'password' => $credentials['password'],
            'auth' => 'manual',
            'confirmed' => 1,
            'firstname' => 'Преподаватель',
            'lastname' => '(LTI-тест)',
            'email' => 'lti_instructor@example.invalid',
            'idnumber' => $marker,
            'mnethostid' => $CFG->mnet_localhost_id,
            'lang' => 'ru',
        ]);
        $user = \core\user::get_user($userid);
    }
    if ($user->idnumber !== $marker || $user->deleted || $user->suspended || is_siteadmin($user)
            || !validate_internal_user_password($user, $credentials['password'])) {
        throw new RuntimeException('Existing instructor differs; it was not overwritten.');
    }
    $context = context_course::instance($course->id);
    // Non-editing teacher is enough for an Instructor launch; no site-admin grant.
    $role = $DB->get_record('role', ['shortname' => 'teacher'], '*', MUST_EXIST);
    foreach (get_user_roles($context, $user->id) as $assigned) {
        if ($assigned->roleid != $role->id) {
            throw new RuntimeException('Instructor has another role; no roles were removed.');
        }
    }
    $manual = enrol_get_plugin('manual');
    foreach (enrol_get_instances($course->id, true) as $instance) {
        if ($instance->enrol === 'manual') {
            $manual->enrol_user($instance, $user->id, $role->id);
            $transaction->allow_commit();
            return;
        }
    }
    throw new RuntimeException('The prepared course must have manual enrolment.');
}

function activate_lab(string $publickey): void {
    global $DB;
    $course = lab_course();
    $type = $course ? lab_tool($course->id) : false;
    if (!$type) {
        throw new RuntimeException('Prepare the local lab before activating it.');
    }
    $key = openssl_pkey_get_public($publickey);
    $details = $key ? openssl_pkey_get_details($key) : false;
    if (!$details || $details['type'] !== OPENSSL_KEYTYPE_RSA || $details['bits'] < 2048) {
        throw new RuntimeException('Expected an RSA public key with at least 2048 bits.');
    }
    $config = lti_get_type_config($type->id);
    if (!empty($config['publickey']) && trim($config['publickey']) !== trim($publickey)) {
        throw new RuntimeException('The registered public key differs; no automatic key rotation.');
    }
    $type->state = LTI_TOOL_STATE_CONFIGURED;
    lti_update_type($type, (object)['lti_keytype' => LTI_RSA_KEY, 'lti_publickey' => trim($publickey)]);
}

function lab_snapshot(): array {
    global $DB, $CFG;
    $course = lab_course();
    if (!$course) {
        throw new RuntimeException('The local lab has not been prepared.');
    }
    $type = lab_tool($course->id);
    $cm = $DB->get_record('course_modules', ['course' => $course->id, 'idnumber' => LAB_ACTIVITY], '*', MUST_EXIST);
    $activity = $DB->get_record('lti', ['id' => $cm->instance], '*', MUST_EXIST);
    $item = grade_item::fetch(['courseid' => $course->id, 'itemtype' => 'mod', 'itemmodule' => 'lti',
        'iteminstance' => $activity->id, 'itemnumber' => 0]);
    if (!$item || $activity->typeid != $type->id || (float)$item->grademax !== 10.0) {
        throw new RuntimeException('Expected the registered tool and its original 10-point grade item.');
    }
    $learners = [];
    foreach (['a', 'b'] as $suffix) {
        $user = \core\user::get_user_by_username('lti_student_' . $suffix);
        $grade = grade_grade::fetch(['itemid' => $item->id, 'userid' => $user->id]);
        $learners[] = [
            'username' => $user->username,
            'userId' => (string)$user->id,
            'name' => fullname($user),
            'grade' => $grade && $grade->finalgrade !== null ? (float)$grade->finalgrade : null,
            'history' => array_values($DB->get_records_sql(
                'SELECT id, source, rawgrade, finalgrade, timemodified FROM {grade_grades_history}
                    WHERE itemid = :itemid AND userid = :userid ORDER BY id',
                ['itemid' => $item->id, 'userid' => $user->id])),
        ];
    }
    $instructor = \core\user::get_user_by_username('lti_instructor');
    $instructorsnapshot = null;
    if ($instructor && $instructor->idnumber === 'rag-lti-local-instructor-v1') {
        $instructorsnapshot = [
            'username' => $instructor->username,
            'userId' => (string)$instructor->id,
            'siteAdmin' => is_siteadmin($instructor),
            'courseRoles' => array_values(array_map(fn($role) => $role->shortname,
                get_user_roles(context_course::instance($course->id), $instructor->id))),
            'gradeRows' => $DB->count_records('grade_grades', ['itemid' => $item->id, 'userid' => $instructor->id]),
            'gradeHistoryRows' => $DB->count_records('grade_grades_history',
                ['itemid' => $item->id, 'userid' => $instructor->id]),
        ];
    }
    return [
        'registration' => get_tool_type_config($type),
        'active' => $type->state == LTI_TOOL_STATE_CONFIGURED,
        'keyType' => lti_get_type_config($type->id)['keytype'],
        'courseId' => (string)$course->id,
        'courseUrl' => $CFG->wwwroot . '/course/view.php?id=' . $course->id,
        'activityUrl' => $CFG->wwwroot . '/mod/lti/view.php?id=' . $cm->id,
        'gradebookUrl' => $CFG->wwwroot . '/grade/report/grader/index.php?id=' . $course->id,
        // LTI resource_link.id is the activity instance ID, not the course-module ID.
        'resourceId' => (string)$activity->id,
        'courseModuleId' => (string)$cm->id,
        'gradeItemId' => (string)$item->id,
        'gradeMaximum' => (float)$item->grademax,
        'ltiGradeItemCount' => $DB->count_records('grade_items', ['courseid' => $course->id, 'itemmodule' => 'lti']),
        'learners' => $learners,
        'instructor' => $instructorsnapshot,
    ];
}

$command = $argv[1] ?? '';
if ($argc !== 2 || !in_array($command, ['prepare', 'activate', 'status', 'instructor'], true)) {
    throw new RuntimeException('Usage: lti-lab.php prepare|activate|status|instructor');
}
if ($command === 'prepare') {
    prepare_lab(json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR));
} else if ($command === 'activate') {
    activate_lab(stream_get_contents(STDIN));
} else if ($command === 'instructor') {
    prepare_instructor(json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR));
}
echo json_encode(lab_snapshot(), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), PHP_EOL;
