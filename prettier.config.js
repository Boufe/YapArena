// Prettier formats the contents of html`...` templates as HTML by default.
// Those templates are rendered output (src/platform/html.ts), so reformatting
// them would change the served markup.
export default {
  overrides: [
    {
      files: ["**/*.{js,ts}"],
      options: { embeddedLanguageFormatting: "off" },
    },
  ],
};
