/**
 * @trustos/cli
 *
 * The `trustos` command. Generates TrustOS applications from the approved,
 * version-controlled templates in this repository — there is no remote
 * template fetch, no plugin resolution and no self-update.
 */
export { run, buildProgram, printDoctorReport } from './program';
export { CLI_VERSION } from './version';
export { createOutput, createCapturingOutput, type Output } from './output';
export { runDoctor, type DoctorReport, type DoctorCheck } from './commands/doctor';
export { runListTemplates } from './commands/list-templates';
export { runTemplates } from './commands/templates';
export { runTemplateDoctor, runUpdateTemplate } from './commands/template-doctor';
export { runValidateTemplate } from './commands/validate-template';
export { runNew } from './commands/new';
export {
  resolveAnswersFromFlags,
  defaultDisplayName,
  defaultPackageName,
  type NewCommandFlags,
  type CollectedAnswers,
} from './prompts';
