import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import * as Sentry from "@sentry/vue";
import { SpeedInsights } from "@vercel/speed-insights/next"
import { Analytics } from "@vercel/analytics/next"

const app = createApp(App)

Sentry.init({
  app,
  dsn: "https://3115bfd7236aa90bd81024a1fdb8c823@o4509821219700736.ingest.de.sentry.io/4509821222518864",
  sendDefaultPii: true
})

app.mount('#app')