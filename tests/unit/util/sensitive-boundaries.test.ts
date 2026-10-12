import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSensitiveChunks, scanSensitiveText } from '../../../src/util/sensitive-scan.js';
import { redactSecretsPreservingLayout } from '../../../src/util/redact-secrets.js';
import {BoundedOutputBuffer} from '../../../src/tools/command-record.js';
test('scanner catches every synthetic credential split and never returns credential fragments',()=>{
  const secret='glpat-'+ 'A'.repeat(32);
  for(let i=1;i<secret.length;i++){const scan=scanSensitiveChunks([secret.slice(0,i),secret.slice(i)]);assert.equal(scan.findings[0]?.rule,'token_prefix');assert.ok(!JSON.stringify(scan).includes(secret));}
  assert.equal(scanSensitiveChunks(['prefix'+secret],8).complete,false);
});
test('multiline redaction preserves source locations and public credential expressions',()=>{
  const source='const password = config.password;\npassword: string;\n-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----\n';assert.equal(redactSecretsPreservingLayout(source),source);assert.deepEqual(scanSensitiveText(source),[]);
  const privateKey='-----BEGIN OPENSSH PRIVATE KEY-----\n'+'A'.repeat(500)+'\n-----END OPENSSH PRIVATE KEY-----';const redacted=redactSecretsPreservingLayout(privateKey);assert.equal(redacted.split('\n').length,privateKey.split('\n').length);assert.ok(!redacted.includes('AAA'));
  assert.ok(!redactSecretsPreservingLayout(JSON.stringify({nested:{result:'postgresql://user:secret@example.test/db'}})).includes('user:secret'));
});
test('truncation retains redaction state after dropping a private-key or token prefix',()=>{
  const buffer=new BoundedOutputBuffer(256,true);buffer.append('-----BEGIN PRIVATE KEY-----\n');for(let i=0;i<30;i++)buffer.append('Q'.repeat(32)+'\n');assert.ok(!buffer.text.includes('QQ'));buffer.append('-----END PRIVATE KEY-----\npublic tail\n');assert.match(buffer.text,/public tail/u);assert.ok(!buffer.text.includes('QQ'));
  const token=new BoundedOutputBuffer(128,true);token.append('Bearer '+'A'.repeat(1024));assert.ok(!token.text.includes('AAA'));token.append('\nnormal log\n');assert.match(token.text,/normal log/u);assert.ok(!token.text.includes('AAA'));
});
