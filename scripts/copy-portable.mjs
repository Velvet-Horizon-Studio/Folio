// Copies the release exe to dist/Folio_<version>_Portable.exe, the name releases use
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
mkdirSync('dist', { recursive: true })
const out = `dist/Folio_${version}_Portable.exe`
copyFileSync('src-tauri/target/release/folio.exe', out)
console.log(`→ ${out}`)
