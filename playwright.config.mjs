import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
 testDir:'tests/e2e',
 testMatch:'*.spec.mjs',
 fullyParallel:false,
 workers:1,
 timeout:120000,
 expect:{timeout:30000},
 retries:process.env.CI?1:0,
 reporter:process.env.CI?'github':'list',
 use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:4173',acceptDownloads:true,trace:'retain-on-failure'},
 webServer:{
  command:'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
  url:'http://127.0.0.1:4173/tests/e2e/harness.html',
  reuseExistingServer:!process.env.CI,
  timeout:120000
 }
});
