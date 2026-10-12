import ts from 'typescript-evaluator';
import{readFile}from'node:fs/promises';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const files=execFileSync('rg',['--files','src/tui','src/cli'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(f=>/\.[jt]sx?$/.test(f)&&!/(?:legacy-translation|settings|rich-text|syntax-highlight|unified-diff|editor|args|exec-output|exec-writer|types|dependencies|slash-commands|help)\./.test(f));
const changes=[],messages={};
const catalog=JSON.parse(await readFile('src/localization/en.json','utf8'));let invalidCalls=0;
const labels=new Set(['title','label','description','placeholder','message','prompt','startLabel','footer','header','text']);
const helpers=/^(?:openInfo|infoView|startCommandLoad|setBusyLabel|setError|setLiveToolStatus|append|appendTransient|write|writeError|output|askSecret|prompt|row|line|formatLine|formatRow|buildRow|field|select|selectMany|choose|confirm|ask)$/;
const human=raw=>{const s=raw.replace(/\{p\d+\}/g,'');return /[A-Za-z]/.test(s)&&!/^\s*(?:https?:|\.{1,2}[/\\]|[\w.-]+\.js$|#[0-9a-f]+$)/i.test(s)&&!/^\/?[a-z_-]+$/.test(s);};
for(const file of files){const text=await readFile(file,'utf8'),sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,file.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS),entries=[];
 function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(sf)==='uiText'&&ts.isStringLiteral(node.arguments[0])){const key=node.arguments[0].text;const entry=catalog[key];if(typeof entry!=='string'){console.error(file+': unknown UI key '+key);invalidCalls++;}else{const required=[...new Set((entry.match(/\{p\d+\}/g)??[]).map(p=>p.slice(1,-1)))];const argument=node.arguments[1];if(!argument&&required.length){console.error(file+': missing UI interpolation '+key);invalidCalls++;}else if(argument&&ts.isObjectLiteralExpression(argument)){const names=new Set(argument.properties.filter(ts.isPropertyAssignment).map(p=>p.name.getText(sf)));for(const parameter of required)if(!names.has(parameter)){console.error(file+': '+key+' missing '+parameter);invalidCalls++;}}}}
 let selected=false,jsx=false;const p=node.parent;
  if(ts.isJsxText(node)&&node.text.trim()&&human(node.text)){selected=true;jsx=true;}
  else if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)){
   if(!ts.isImportDeclaration(p)&&!ts.isLiteralTypeNode(p)&&!ts.isElementAccessExpression(p)&&!(ts.isBinaryExpression(p)&&[ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)))selected=true;
   if(ts.isJsxAttribute(p)&&labels.has(p.name.text))selected=true;
   if(ts.isPropertyAssignment(p)&&labels.has(p.name.getText(sf)))selected=true;
   if(ts.isCallExpression(p)&&helpers.test(p.expression.getText(sf).split('.').at(-1))){const i=p.arguments.indexOf(node);selected=!p.expression.getText(sf).startsWith('append')||i>0;}
   if(ts.isReturnStatement(p))selected=true;
   if(ts.isBinaryExpression(p)&&p.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken&&p.right===node)selected=true;
   if(ts.isNewExpression(p)&&p.expression.getText(sf)==='Error')selected=true;
   if(ts.isConditionalExpression(p)&&p.condition!==node){let a=p;while(a&&!ts.isJsxExpression(a)&&!ts.isJsxAttribute(a)&&!ts.isStatement(a))a=a.parent;if(a&&(ts.isJsxExpression(a)||ts.isJsxAttribute(a)))selected=true;}
   if(ts.isJsxExpression(p)){selected=!ts.isJsxAttribute(p.parent)||labels.has(p.parent.name.text);}
  }
  if(selected){let en='',args=[];
   if(ts.isTemplateExpression(node)){en=node.head.text;node.templateSpans.forEach((span,i)=>{en+='{p'+i+'}'+span.literal.text;args.push(span.expression.getText(sf));});}
   else en=node.text;
   if(jsx){const lines=en.split(/\r?\n/);en=lines.map((line,i)=>{let x=line.replace(/\t/g,' ');if(i>0)x=x.trimStart();if(i<lines.length-1)x=x.trimEnd();return x;}).filter(Boolean).join(' ');}
   if(human(en)&&!Array.from(en).some(c=>c.codePointAt(0)<32&&!['\t','\n','\r'].includes(c))&&!/^m[0-9a-f]{12}$/.test(en)&&!(/^[a-z]+[A-Z][a-zA-Z]+$/.test(en))&&!/^[A-Za-z_][\w./-]*$/.test(en)&&!['PowerShell','Bash','Everpeace','N/A','API Key','OpenAI','Executor unavailable'].includes(en)){const key='m'+createHash('sha256').update(en).digest('hex').slice(0,12);messages[key]=en;entries.push({start:node.getStart(sf),end:node.getEnd(),key,en,args,jsx,attribute:ts.isJsxAttribute(p)});}
  }
  ts.forEachChild(node,visit);
 }visit(sf);if(entries.length)changes.push({file,entries});
}

const allowed=new Set(['/plan ','node:module','Implement the following plan, which the user approved and explicitly started with /plan execute. Inspect current files and project rules before editing, respect current permissions, and verify the result.\n\nTitle: {p0}\n\n{p1}','profile ','trust ','revoke ','remember ','Continue working toward the active session goal. Call get_goal first, then proceed until the objective is verified complete.','Continue working toward the restored active session goal. Call get_goal first and proceed until the objective is verified complete.']);
// These are parser grammar, a module specifier, and model instructions; they are not host UI.
const remaining=changes.flatMap(({file,entries})=>entries.filter(entry=>!allowed.has(entry.en)).map(entry=>({file,entry})));
if(invalidCalls)process.exitCode=1;
if(remaining.length){for(const {file,entry} of remaining)console.error(file+': host text must use uiText: '+JSON.stringify(entry.en));process.exitCode=1;}else console.log('Host presentation copy uses the centralized catalog.');
