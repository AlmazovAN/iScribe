import {defineConfig,devices} from '@playwright/test';
// Production bundle is required: Vite dev server intentionally does not register the SW.
export default defineConfig({
 testDir:'tests/offline',testMatch:'*.spec.mjs',fullyParallel:false,workers:1,
 timeout:120000,expect:{timeout:45000},
 retries:process.env.CI?1:0,
 reporter:process.env.CI?'github':'list',
 use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:4174',trace:'retain-on-failure'},
 webServer:[{
  command:'npx vite preview --outDir dist-web --host 127.0.0.1 --port 4174 --strictPort',
  url:'http://127.0.0.1:4174/',
  reuseExistingServer:!process.env.CI,
  timeout:120000
 },{
  command:'npm run serve:isolated',
  url:'http://127.0.0.1:4175/',
  reuseExistingServer:!process.env.CI,
  timeout:120000
 }]
});
