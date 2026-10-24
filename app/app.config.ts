export default defineAppConfig({
  ui: {
    colors: {
      // the signature Abyss theme (an intense bioluminescent accent over
      // deep-sea rock neutrals; palettes in app/assets/css/main.css);
      // users can override primary/neutral in Settings (app/plugins/
      // theme-color.ts applies the per-browser choice from localStorage)
      primary: 'abyss',
      neutral: 'abyssrock'
    }
  }
})
