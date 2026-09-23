import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
await mkdir(join(root,'secrets'),{recursive:true,mode:0o700});await chmod(join(root,'secrets'),0o700);
try{await writeFile(join(root,'secrets/encryption_key'),randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});console.log('Encryption key created. Back it up securely with the data volume.');}
catch(error){if(error.code!=='EEXIST')throw error;console.log('Existing encryption key kept unchanged.');}
