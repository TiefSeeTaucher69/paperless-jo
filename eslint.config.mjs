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
    // AUDIT-024: no-unused-vars ist ueberwiegend Altlast (83 Fundstellen ueber ~20 Dateien)
    // ohne Laufzeitrisiko - als Warnung sichtbar, aber kein CI-Blocker. no-undef/
    // no-const-assign/no-dupe-class-members bleiben 'error' (Standard aus
    // pluginJs.configs.recommended) und blockieren die CI, weil sie echte Bugs waeren
    // (siehe AUDIT-023, wo genau diese drei Regeln reale Fehler markiert hatten).
    rules: {
      "no-unused-vars": "warn",
    },
  },
  prettier, // Prettier integriert
];
