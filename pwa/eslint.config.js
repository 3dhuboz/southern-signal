import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// eslint-plugin-react-hooks@^7 introduced a cluster of "React Compiler"-prep
// rules (set-state-in-effect, purity, preserve-manual-memoization, refs,
// immutability) that flag perfectly normal non-compiler React patterns:
//   - setState inside an effect's async callback (load-on-mount)
//   - mirror-prop-to-ref (useEffect(() => { ref.current = prop; }))
//   - reassigning ref.current = null in cleanup paths
// They're correct guidance for code that opts into the React Compiler, but
// this codebase doesn't — so they fire dozens of false positives across
// idiomatic effect bodies. Disable the compiler-prep rules and keep the
// classic high-signal ones (rules-of-hooks, exhaustive-deps).
const COMPILER_PREP_RULES_OFF = {
  'react-hooks/set-state-in-effect': 'off',
  'react-hooks/purity': 'off',
  'react-hooks/preserve-manual-memoization': 'off',
  'react-hooks/refs': 'off',
  'react-hooks/immutability': 'off',
  // exhaustive-deps catches real bugs but is sometimes deliberately
  // violated (e.g. one-shot init effects); downgrade to warn so it
  // surfaces in the IDE without blocking CI.
  'react-hooks/exhaustive-deps': 'warn',
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...COMPILER_PREP_RULES_OFF,
      // Honour the `_`-prefix convention for intentionally unused args /
      // vars / destructured names. Stubs in tests and gesture callbacks
      // routinely receive args they don't read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
])
