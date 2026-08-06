import globals from "globals";
import pluginJs from "@eslint/js";
import prettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  pluginJs.configs.recommended,
  {
    // Diese Bibliotheken werden ausschliesslich per <script>-Tag in den EJS-Views geladen
    // (u.a. views/settings.ejs, dashboard.ejs, history.ejs, manual.ejs, chat.ejs, setup.ejs) -
    // ESLint sieht pro Datei nur den lokalen Scope und kennt diese globalen Bezeichner sonst
    // nicht (AUDIT-024). getCsrfToken (public/js/csrf.js) und modalManager
    // (window.modalManager, siehe public/js/dashboard.js/manual.js) sind Projekt-eigene,
    // ebenso ueber die <script>-Reihenfolge geteilte Globals.
    files: ["public/js/**/*.js"],
    languageOptions: {
      globals: {
        Swal: "readonly",
        $: "readonly",
        Chart: "readonly",
        marked: "readonly",
        hljs: "readonly",
        tippy: "readonly",
        Sortable: "readonly",
        getCsrfToken: "readonly",
        modalManager: "readonly",
      },
    },
  },
  {
    // AUDIT-024/NACHAUDIT-16: alle projektweiten no-unused-vars-Altlasten sind behoben
    // (Nachaudit 2026-08-04, Arbeitsplan Punkt 5) - die Regel ist jetzt 'error' statt 'warn',
    // damit ein lokales `eslint .` denselben Befund liefert wie die CI (`npm run lint`,
    // --max-warnings=0). no-undef/no-const-assign/no-dupe-class-members waren bereits 'error'
    // (Standard aus pluginJs.configs.recommended), siehe AUDIT-023.
    rules: {
      "no-unused-vars": "error",
    },
  },
  prettier, // Prettier integriert
];
