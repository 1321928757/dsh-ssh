/**
 * Compatibility alias for callers that used the extracted upstream config name.
 * The independent repository has no parent workspace/shared import; its only
 * build configuration is the local standalone tsdown.config.ts.
 */
export { default } from './tsdown.config.ts'
