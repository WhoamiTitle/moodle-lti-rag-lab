import { AppError } from "./errors.mjs";

export const SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const LEARNER_ROLES = new Set(["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"]);
const STAFF_ROLES = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Mentor",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator",
]);

export function launchSession(context, config) {
  const token = context.idToken;
  const expected = config.moodle;
  if (
    !expected ||
    token.platform.url !== expected.issuer ||
    token.platform.clientId !== expected.clientId ||
    token.platform.deploymentId !== expected.deploymentId
  ) {
    throw new AppError(403, "deployment_not_allowed", "Этот LTI deployment не разрешён в настройках тренажёра.");
  }
  if (token.launch.target !== `${config.publicUrl}/lti/launch`) {
    throw new AppError(400, "invalid_target", "Неверный URL запуска инструмента.");
  }
  const resourceLinkId = token.launch.resource?.id;
  const contextId = token.launch.context?.id;
  if (typeof resourceLinkId !== "string" || !resourceLinkId || typeof contextId !== "string" || !contextId) {
    throw new AppError(400, "missing_context", "Запуск должен содержать идентификаторы курса и элемента Moodle.");
  }
  const roles = token.user.roles;
  // Course-role Learner is required. Staff or dual-role launches stay read-only.
  const isStaff = roles.some(
    (role) =>
      STAFF_ROLES.has(role) ||
      (role.startsWith("http://purl.imsglobal.org/vocab/lis/v2/membership#") && !LEARNER_ROLES.has(role)),
  );
  const isLearner = !isStaff && roles.some((role) => LEARNER_ROLES.has(role));
  const ags = token.services.assignmentAndGrades;
  let gradeUnavailable = null;
  if (
    !ags.available ||
    typeof ags.lineItemId !== "string" ||
    !ags.lineItemId ||
    !Array.isArray(ags.scopes) ||
    !ags.scopes.includes(SCORE_SCOPE)
  ) {
    gradeUnavailable =
      "В запуске нет колонки оценки или разрешения AGS score. Включите принятие оценок в настройках External tool и запустите его снова.";
  } else {
    let target;
    try {
      target = new URL(ags.lineItemId);
    } catch {
      throw new AppError(400, "invalid_line_item", "Некорректный URL колонки AGS.");
    }
    if (target.origin !== new URL(expected.issuer).origin || target.username || target.password || target.hash) {
      throw new AppError(
        400,
        "invalid_line_item",
        "Для Moodle колонка AGS должна принадлежать зарегистрированной платформе.",
      );
    }
  }
  return {
    context,
    scope: {
      issuer: token.platform.url,
      clientId: token.platform.clientId,
      deploymentId: token.platform.deploymentId,
      userId: token.user.id,
      contextId,
      resourceLinkId,
    },
    displayName:
      token.user.name ||
      [token.user.givenName, token.user.familyName].filter(Boolean).join(" ") ||
      `Участник ${token.user.id}`,
    contextTitle: token.launch.context.title || token.launch.context.label || contextId,
    resourceTitle: token.launch.resource.title || resourceLinkId,
    roles,
    isLearner,
    gradeUnavailable,
    lineItemId: ags.lineItemId || null,
  };
}
