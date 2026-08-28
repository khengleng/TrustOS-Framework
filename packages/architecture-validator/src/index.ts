/**
 * @trustos/architecture-validator
 *
 * Layering, naming, dependency direction, folder structure and security rules.
 *
 * The rules a codebase actually lives by are the ones a machine checks; everything else is a
 * document people agree with and then violate, because the violation is invisible until somebody
 * reads the whole tree. So the rules are data and the failures name a file, a line and a fix.
 *
 * It takes files as data and never touches the filesystem, which is what lets a pre-commit hook,
 * CI and `trustos architecture-check` all behave identically.
 */
export * from './rules';
export * from './validator';
