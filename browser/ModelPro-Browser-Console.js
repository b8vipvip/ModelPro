/*
 ModelPro Browser Console Verifier v0.2.0
 Paste this entire file into Chrome DevTools Console on https://chatgpt.com/
 It discovers visible model choices, selects each model, sends deterministic probes,
 validates the visible answer, and automatically downloads a JSON report.

 IMPORTANT AUTHORITY NOTE:
 JavaScript pasted into a normal page console cannot use chrome.debugger/CDP.
 Therefore this standalone script can verify UI selection + real conversation probe
 responses, but cannot independently prove the backend-served model identity.
*/
(async () => {
  'use strict';
  const VERSION='0.2.0-browser', MARKER='ModelPro 浏览器验证';
  const WAIT=ms=>new Promise(r=>setTimeout(r,ms));
  const now=()=>new Date().toISOString();
  const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
  const logs=[], report={
    type:'modelpro-browser-console-report',schemaVersion:1,version:VERSION,startedAt:now(),
    page:{url:location.href,userAgent:navigator.userAgent},
    authority:{uiSelection:true,probeAnswer:true,backendServedModel:false,
      backendReason:'chrome.debugger/CDP is unavailable to JavaScript pasted into a normal page console'},
    discoveredModels:[],results:[],logs
  };
  let panel,statusEl,finalized=false;
  const log=(level,event,details={})=>{
    const row={ts:now(),level,event,details}; logs.push(row);
    (level==='error'?console.error:level==='warn'?console.warn:console.log)('[ModelPro]['+level+'] '+event,details);
    paint();
  };
  function probe(ordinal,total){
    const n=Math.max(1,Number(ordinal)||1),left=120+n*7,right=31+n*5,offset=n*n+17;
    return {ordinal:n,total:Math.max(n,Number(total)||n),left,right,offset,
      expectedValue:left*right+offset,
      text:MARKER+' '+n+'/'+Math.max(n,Number(total)||n)+'：计算 ('+left+'×'+right+')+'+offset+'，只输出“校验值=<整数>”，不要解释、不要复述题目。'};
  }
  function chronology(label){
    const s=norm(label).toLowerCase();
    if(/gpt[\s-]*5\.5/.test(s))return[-1,5,5,s];
    const m=s.match(/gpt[\s-]*(\d+)(?:\.(\d+))?(.*)/);
    return m?[0,+m[1],+(m[2]||0),m[3]||'']:[1,999,999,s];
  }
  function compare(a,b){ const x=chronology(a.label),y=chronology(b.label); for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i]; return x[3].localeCompare(y[3]); }
  function paint(){ if(!statusEl)return; const last=logs.at(-1); statusEl.textContent='ModelPro '+VERSION+'\n'+(last?last.event:'starting')+'\nresults '+report.results.length+'/'+report.discoveredModels.length; }
  function makePanel(){
    panel=document.createElement('div'); panel.id='modelpro-browser-panel';
    Object.assign(panel.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:2147483647,width:'340px',padding:'12px',background:'#111',color:'#fff',font:'12px/1.45 Consolas,monospace',border:'1px solid #555',borderRadius:'8px',boxShadow:'0 4px 20px #0008',whiteSpace:'pre-wrap'});
    statusEl=document.createElement('div'); panel.append(statusEl);
    const stop=document.createElement('button'); stop.textContent='停止并导出'; stop.style.marginTop='8px'; stop.onclick=()=>{window.__MODELPRO_STOP__=true;finalize('stopped_by_user')}; panel.append(stop); document.body.append(panel);
  }
  const visible=el=>!!el&&el.isConnected&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0;
  const textOf=el=>norm(el?.innerText||el?.textContent||el?.getAttribute?.('aria-label')||'');
  function click(el){ el.scrollIntoView({block:'center',inline:'center'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); el.click(); }
  function findComposer(){
    const c=[document.querySelector('#prompt-textarea'),document.querySelector('textarea[data-id="root"]'),...document.querySelectorAll('textarea'),...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    return c.find(el=>/prompt|message|ask|chat/i.test([el.id,el.getAttribute('data-testid'),el.getAttribute('aria-label'),el.getAttribute('placeholder')].join(' ')))||c.at(-1)||null;
  }
  function setComposer(el,text){
    el.focus();
    if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){ const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text); el.dispatchEvent(new Event('input',{bubbles:true})); }
    else { el.textContent=text; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text})); }
  }
  function findSend(){ return [...document.querySelectorAll('button')].filter(visible).find(b=>/send|发送/i.test([b.getAttribute('data-testid'),b.getAttribute('aria-label'),textOf(b)].join(' '))&&!b.disabled); }
  async function sendPrompt(text){ const c=findComposer(); if(!c)throw new Error('找不到 ChatGPT 输入框'); setComposer(c,text); await WAIT(300); const b=findSend(); if(b)click(b); else c.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})); log('info','probe_sent',{text}); }
  function assistantBlocks(){ const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible); if(a.length)return a; return [...document.querySelectorAll('article[data-testid^="conversation-turn"]')].filter(visible); }
  async function waitAnswer(expected,beforeCount,timeout=120000){
    const deadline=Date.now()+timeout; let last='';
    while(Date.now()<deadline){ if(window.__MODELPRO_STOP__)throw new Error('stopped'); const blocks=assistantBlocks(),fresh=blocks.slice(Math.max(0,beforeCount-1)); last=norm(fresh.map(textOf).join('\n')); const matches=[...last.matchAll(/校验值\s*[=＝:：]\s*(\d+)/g)]; const m=matches.at(-1); if(m)return{answer:+m[1],text:last.slice(-2000),ok:+m[1]===expected}; await WAIT(500); }
    return{answer:null,text:last.slice(-2000),ok:false,timedOut:true};
  }
  function pickerCandidates(){ return [...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(el=>{ const s=[textOf(el),el.getAttribute('aria-label'),el.getAttribute('data-testid')].join(' '); return /model|模型|gpt|chatgpt/i.test(s)&&!/send|发送/i.test(s); }); }
  async function openPicker(){ const c=pickerCandidates(); const p=c.find(el=>/model|模型|gpt/i.test([el.getAttribute('data-testid'),el.getAttribute('aria-label'),textOf(el)].join(' '))); if(!p)throw new Error('找不到模型选择器按钮'); click(p); await WAIT(800); return p; }
  function menuModelRows(){
    const items=[...document.querySelectorAll('[role="menuitem"],[role="option"],button')].filter(visible),rows=[];
    for(const el of items){ const label=textOf(el); if(!label||label.length>180)continue; if(!/(GPT|ChatGPT|Astra|Sol|Pro|Luna|Terra|o\d)/i.test(label))continue; if(/upgrade|plan|设置|settings|new chat|temporary|send|发送/i.test(label))continue; rows.push({label,el}); }
    const seen=new Set(); return rows.filter(r=>{const k=r.label.toLowerCase();if(seen.has(k))return false;seen.add(k);return true});
  }
  async function discover(){ await openPicker(); const rows=menuModelRows(); if(!rows.length){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));throw new Error('模型菜单已打开，但未发现可识别模型项');} report.discoveredModels=rows.map(r=>({label:r.label})).sort(compare); log('info','models_discovered',{models:report.discoveredModels.map(x=>x.label)}); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await WAIT(300); return report.discoveredModels; }
  async function selectModel(label){ await openPicker(); const rows=menuModelRows(),low=label.toLowerCase(); const row=rows.find(r=>r.label===label)||rows.find(r=>r.label.toLowerCase().includes(low)||low.includes(r.label.toLowerCase())); if(!row)throw new Error('模型菜单中找不到: '+label); click(row.el); await WAIT(900); log('info','model_selected',{label}); }
  function download(obj){ const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}); const a=document.createElement('a'),stamp=new Date().toISOString().replace(/[:.]/g,'-'); a.href=URL.createObjectURL(blob); a.download='ModelPro-Browser-Report-'+stamp+'.json'; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),3000); }
  function finalize(reason='completed'){
    if(finalized)return; finalized=true; report.completedAt=now(); report.finishReason=reason;
    report.summary={total:report.discoveredModels.length,completed:report.results.length,passed:report.results.filter(x=>x.probeAnswerConfirmed).length,failed:report.results.filter(x=>!x.probeAnswerConfirmed).length,backendServedModelConfirmed:0,outcome:report.results.length===report.discoveredModels.length&&report.results.every(x=>x.probeAnswerConfirmed)?'browser_probe_pass':'browser_probe_incomplete'};
    log('info','verification_finished',report.summary); download(report); if(statusEl)statusEl.textContent+='\n\n完成：'+report.summary.outcome+'\nJSON 已自动下载'; window.__MODELPRO_REPORT__=report;
  }
  try{
    if(location.hostname!=='chatgpt.com')throw new Error('请在 https://chatgpt.com/ 页面运行');
    window.__MODELPRO_STOP__=false; makePanel(); log('info','verification_started',{version:VERSION});
    const models=await discover(); if(!models.length)throw new Error('未发现模型');
    for(let i=0;i<models.length;i++){
      if(window.__MODELPRO_STOP__)break;
      const model=models[i],result={ordinal:i+1,label:model.label,startedAt:now(),uiSelected:false,probeAnswerConfirmed:false,backendServedModelConfirmed:false,backendEvidence:'not_available_in_page_console'};
      try{ await selectModel(model.label); result.uiSelected=true; const p=probe(i+1,models.length); result.probe=p; const before=assistantBlocks().length; await sendPrompt(p.text); const ans=await waitAnswer(p.expectedValue,before); result.answer=ans.answer; result.answerExcerpt=ans.text; result.probeAnswerConfirmed=ans.ok; result.timedOut=ans.timedOut===true; if(!ans.ok)result.error=ans.timedOut?'response_timeout':'unexpected_answer:'+ans.answer; }
      catch(e){ result.error=e?.message||String(e); log('error','model_verification_error',{model:model.label,error:result.error}); }
      result.completedAt=now(); report.results.push(result); log(result.probeAnswerConfirmed?'info':'warn','model_verification_result',result);
    }
    finalize(window.__MODELPRO_STOP__?'stopped_by_user':'completed');
  }catch(e){ report.fatalError=e?.stack||String(e); log('error','fatal',{error:report.fatalError}); finalize('fatal_error'); }
})();