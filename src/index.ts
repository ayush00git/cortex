import { promises as fs } from 'fs';

async function main() {
  console.log('🚀 Seam AI TypeScript Environment Initialized Successfully!');
  
  // Quick test of basic Node APIs and async/await
  const packageJsonContent = await fs.readFile('./package.json', 'utf-8');
  const packageJson = JSON.parse(packageJsonContent);
  console.log(`📦 Project Name: ${packageJson.name}`);
  console.log(`✨ Node.js version: ${process.version}`);
}

main().catch((err) => {
  console.error('❌ Error running main:', err);
  process.exit(1);
});
