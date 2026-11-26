import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:['dist/**','dist-web/**','node_modules/**','test-results/**','playwright-report/**']},...tseslint.configs.recommended);
