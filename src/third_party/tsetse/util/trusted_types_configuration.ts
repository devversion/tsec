/**
 * Trusted Types configuration used to match Trusted values in the assignments
 * to sinks.
 */
export interface TrustedTypesConfig {
  /**
   * The suffix of the absolute path of the definition file.
   */
  modulePathSuffix: string;
  /**
   * The fully qualified name of the trusted type to allow. E.g.
   * "global.TrustedHTML".
   */
  fullyQualifiedName: string;
}

/**
 * Create `TrustedTypesConfig` for the given Trusted Type.
 */
function createDefaultTrustedTypeConfig(
    type: 'TrustedHTML'|'TrustedScript'|
    'TrustedScriptURL'): TrustedTypesConfig {
  const config = {
    // the module path may look like
    // "/home/username/.../node_modules/@types/trusted-types/index.d.ts"
    modulePathSuffix: '/node_modules/@types/trusted-types/index.d.ts',
    fullyQualifiedName: 'global.' + type
  };

  return config;
}

/**
 * Trusted Types configuration allowing usage of `TrustedHTML` for a given rule.
 */
export const TRUSTED_HTML = createDefaultTrustedTypeConfig('TrustedHTML');

/**
 * Trusted Types configuration allowing usage of `TrustedScript` for a given
 * rule.
 */
export const TRUSTED_SCRIPT = createDefaultTrustedTypeConfig('TrustedScript');

/**
 * Trusted Types configuration allowing usage of `TrustedScriptURL` for a given
 * rule.
 */
export const TRUSTED_SCRIPT_URL =
    createDefaultTrustedTypeConfig('TrustedScriptURL');
