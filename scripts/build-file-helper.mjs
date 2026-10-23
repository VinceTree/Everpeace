import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') { console.log('Native file access is unavailable on this platform.'); process.exit(0); }
const directory = path.join(root, 'native', 'files', 'bin', `${process.platform}-${process.arch}`);
mkdirSync(directory, { recursive: true });
const testing = process.argv.includes('--test');
const output = path.join(directory, testing ? 'everpeace-files-test.exe' : 'everpeace-files.exe');
const source = path.join(root, 'native', 'files', 'main.cpp');
let compiler = process.env.EVERPEACE_FILE_CXX || 'g++';
let buildEnv = process.env;
if (!process.env.EVERPEACE_FILE_CXX && spawnSync('g++', ['--version'], { windowsHide: true, stdio: 'ignore' }).error) {
  const finder = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(finder)) throw new Error('Install MinGW-w64 g++ or Visual Studio C++ Build Tools, then run pnpm files:build.');
  const installation = spawnSync(finder, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  if (!installation) throw new Error('Visual Studio C++ tools are unavailable');
  const variables = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const setup = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${variables}" >nul && set"`], { encoding: 'utf8', windowsHide: true });
  if (setup.status !== 0) throw new Error('C++ build environment setup failed');
  buildEnv = { ...process.env };
  for (const line of setup.stdout.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) buildEnv[line.slice(0, index)] = line.slice(index + 1); }
  compiler = 'cl.exe';
}
const args = path.basename(compiler).toLowerCase().startsWith('cl')
  ? [...(testing ? ['/DEP_FILE_TEST'] : []), '/std:c++17', '/EHsc', '/O2', '/MT', source, `/Fe:${output}`, 'bcrypt.lib', 'advapi32.lib']
  : [...(testing ? ['-DEP_FILE_TEST'] : []), '-std=c++17', '-O2', '-static', '-o', output, source, '-lbcrypt', '-ladvapi32'];
const result = spawnSync(compiler, args, { cwd: directory, windowsHide: true, stdio: 'inherit', shell: false, env: buildEnv });
if (result.error || result.status !== 0) throw result.error || new Error('Native file helper build failed');
writeFileSync(`${output}.sha256`, createHash('sha256').update(readFileSync(output)).digest('hex'));
console.log(`Built file helper for ${process.platform}-${process.arch}`);
if (testing) {
  const processDirectory = path.join(root, 'native/process/bin', `${process.platform}-${process.arch}`);
  mkdirSync(processDirectory, { recursive: true });
  const processOutput = path.join(processDirectory, 'everpeace-output-test.exe');
  const processSource = path.join(root, 'native/process/output-test.cpp');
  const fixtureArgs = path.basename(compiler).toLowerCase().startsWith('cl') ? ['/EHsc', '/O2', '/MT', processSource, `/Fe:${processOutput}`] : ['-O2', '-static', '-o', processOutput, processSource];
  const built = spawnSync(compiler, fixtureArgs, { cwd: processDirectory, windowsHide: true, stdio: 'inherit', env: buildEnv });
  if (built.error || built.status !== 0) throw built.error || new Error('Process fixture build failed');
}
if (!testing) {
  const processDirectory = path.join(root, 'native/process/bin', `${process.platform}-${process.arch}`);
  mkdirSync(processDirectory, { recursive: true });
  const processOutput = path.join(processDirectory, 'everpeace-process.exe');
  const processSource = path.join(root, 'native/process/main.cpp');
  const processArgs = path.basename(compiler).toLowerCase().startsWith('cl')
    ? ['/std:c++17', '/EHsc', '/O2', '/MT', processSource, `/Fe:${processOutput}`, 'advapi32.lib']
    : ['-std=c++17', '-O2', '-static', '-municode', '-o', processOutput, processSource, '-ladvapi32'];
  const processBuild = spawnSync(compiler, processArgs, { cwd: processDirectory, windowsHide: true, stdio: 'inherit', shell: false, env: buildEnv });
  if (processBuild.error || processBuild.status !== 0) throw processBuild.error || new Error('Native process owner build failed');
  writeFileSync(`${processOutput}.sha256`, createHash('sha256').update(readFileSync(processOutput)).digest('hex'));
  console.log(`Built process owner for ${process.platform}-${process.arch}`);
}
