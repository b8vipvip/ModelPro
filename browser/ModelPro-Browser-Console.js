/*
 ModelPro Browser Console Verifier v0.4.3
 Paste this entire file into Chrome DevTools Console on https://chatgpt.com/
 It uses conversation-driven discovery when the home page has no visible model picker,
 validates the visible answer, and automatically downloads a JSON report.

 IMPORTANT AUTHORITY NOTE:
 JavaScript pasted into a normal page console cannot use chrome.debugger/CDP.
 Therefore this standalone script can verify UI selection + real conversation probe
 responses, but cannot independently prove the backend-served model identity.
*/
(async () => {
  'use strict';
  const VERSION='0.4.3-browser', MARKER='ModelPro 浏览器验证';
  const WAIT=ms=>new Promise(r=>setTimeout(r,ms));
  const now=()=>new Date().toISOString();
  const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
  const logs=[], diagnostics=[];
  let emergencyLogTimer=null, lastExportSignature='';
  function exportLog(reason='checkpoint'){
    try{
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      const sig=reason+'|'+logs.length+'|'+diagnostics.length+'|'+report.results.length;
      if(sig===lastExportSignature)return;
      lastExportSignature=sig;
      downloadText(buildLogText(),'ModelPro-Browser-'+VERSION+'-'+reason+'-'+stamp+'.log');
    }catch(e){ console.error('[ModelPro] log export failed',e); }
  }
  function armEmergencyExport(){
    if(emergencyLogTimer)clearInterval(emergencyLogTimer);
    emergencyLogTimer=setInterval(()=>exportLog('checkpoint'),15000);
  }
  const report={
    type:'modelpro-browser-console-report',schemaVersion:1,version:VERSION,
    versionInfo:{name:'ModelPro Browser Console Verifier',version:VERSION,reportSchemaVersion:1},
    startedAt:now(),
    page:{url:location.href,userAgent:navigator.userAgent},
    authority:{uiSelection:true,probeAnswer:true,backendServedModel:false,
      backendReason:'chrome.debugger/CDP is unavailable to JavaScript pasted into a normal page console'},
    discoveredModels:[],results:[],logs,diagnostics
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
    Object.assign(panel.style,{position:'fixed',right:'16px',bottom:'110px',zIndex:2147483647,width:'340px',padding:'12px',background:'rgba(17,17,17,0.35)',color:'#fff',font:'12px/1.45 Consolas,monospace',border:'1px solid #555',borderRadius:'8px',boxShadow:'0 4px 20px #0008',whiteSpace:'pre-wrap'});
    const title=document.createElement('div');
    title.textContent='ModelPro '+VERSION;
    Object.assign(title.style,{fontWeight:'700',marginBottom:'6px'});
    panel.append(title);
    statusEl=document.createElement('div'); panel.append(statusEl);
    const stop=document.createElement('button'); stop.textContent='停止并导出'; stop.style.marginTop='8px'; stop.onclick=()=>{window.__MODELPRO_STOP__=true;finalize('stopped_by_user')}; panel.append(stop); document.body.append(panel);
  }
  const rendered=el=>!!el&&el.isConnected&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0;
  const visible=el=>{if(!rendered(el))return false; const r=el.getBoundingClientRect(); return r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
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
  function assistantBlocks(){ const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(rendered); if(a.length)return a; return [...document.querySelectorAll('article[data-testid^="conversation-turn"]')].filter(rendered); }
  function latestAssistant(){const a=assistantBlocks();return a.at(-1)||null;}
  async function waitBoundAssistantAnswer(expected,target,timeout=60000){
    const deadline=Date.now()+timeout; let last='',lastText='',stableSince=0;
    while(Date.now()<deadline){
      if(window.__MODELPRO_STOP__)throw new Error('stopped');
      const newest=latestAssistant(); if(newest&&newest!==target&&textOf(newest)!=='正在思考')target=newest;
      if(target&&target.isConnected){
        last=norm(textOf(target));
        const generating=!!document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]');
        if(last===lastText&&last){if(!stableSince)stableSince=Date.now();}else{lastText=last;stableSince=Date.now();}
        const matches=[...last.matchAll(/校验值\s*[=＝:：]\s*(\d+)/g)],m=matches.at(-1);
        if(m&&!generating&&Date.now()-stableSince>=800)return {answer:+m[1],text:last.slice(-2000),ok:+m[1]===expected,turnStable:true};
      }
      await WAIT(250);
    }
    return {answer:null,text:last.slice(-2000),ok:false,timedOut:true};
  }
  async function waitAnswer(expected,beforeCount,timeout=120000){
    const deadline=Date.now()+timeout; let last='',stableSince=0,lastText='',target=null;
    while(Date.now()<deadline){
      if(window.__MODELPRO_STOP__)throw new Error('stopped');
      const blocks=assistantBlocks();
      if(!target && blocks.length>beforeCount) target=blocks[blocks.length-1];
      if(target && target.isConnected){
        last=norm(textOf(target));
        const generating=!!document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]');
        if(last===lastText && last) { if(!stableSince)stableSince=Date.now(); }
        else { lastText=last; stableSince=Date.now(); }
        const stable=Date.now()-stableSince>=1200;
        if(!generating && stable){
          const matches=[...last.matchAll(/校验值\s*[=＝:：]\s*(\d+)/g)],m=matches.at(-1);
          if(m)return{answer:+m[1],text:last.slice(-2000),ok:+m[1]===expected,turnStable:true};
          return{answer:null,text:last.slice(-2000),ok:false,missingAnswer:true,turnStable:true};
        }
      }
      await WAIT(300);
    }
    return{answer:null,text:last.slice(-2000),ok:false,timedOut:true};
  }
  function inSidebar(el){
    return !!el?.closest?.('nav,aside,[data-testid*="sidebar" i],[class*="sidebar" i]');
  }
  function invalidModelLabel(label){
    return /打开[“"].*对话|对话选项|置顶|GPTWork|GPTAuto|修复|发布收口|conversation options|pin\b/i.test(label);
  }
  function modeControls(){
    return [...document.querySelectorAll('button[role="radio"],[role="radio"]')]
      .filter(visible).filter(el=>!inSidebar(el))
      .filter(el=>/^(聊天|chat|工作|work)$/i.test(textOf(el)));
  }
  function pickerCandidates(){
    const selectors=[
      '[data-testid*="model"][role="button"]','button[data-testid*="model"]',
      '[aria-label*="model" i]','[aria-label*="模型"]','[aria-label*="切换模型"]',
      'header button','main button'
    ];
    const all=[...new Set(selectors.flatMap(s=>[...document.querySelectorAll(s)]))]
      .filter(visible).filter(el=>!inSidebar(el));
    const topCenter=[...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(el=>{
      if(inSidebar(el))return false;
      const r=el.getBoundingClientRect(),cx=r.left+r.width/2;
      const s=[textOf(el),el.getAttribute('aria-label'),el.getAttribute('data-testid')].join(' ');
      return r.top<150 && cx>innerWidth*.20 && cx<innerWidth*.80 &&
        /model|模型|切换模型|gpt|astra|sol|pro|luna|terra/i.test(s) &&
        !/share|共享|send|发送|new chat|新聊天/i.test(s);
    });
    all.push(...topCenter.filter(x=>!all.includes(x)));
    return all.filter(el=>{
      const r=el.getBoundingClientRect();
      const s=[textOf(el),el.getAttribute('aria-label'),el.getAttribute('data-testid')].join(' ');
      return r.top < Math.min(180, innerHeight*.22) &&
        /model|模型|切换模型|gpt|chatgpt|astra|sol|pro|luna|terra/i.test(s) &&
        !invalidModelLabel(s) && !/send|发送|share|共享|new chat/i.test(s);
    });
  }
  async function openPicker(){
    const c=pickerCandidates();
    diagnostic('picker_candidates',c.length?'info':'warn',{count:c.length,candidates:c.slice(0,30).map(elementSnapshot)});
    if(!c.length){
      const modes=modeControls();
      diagnostic('mode_controls','info',{count:modes.length,controls:modes.map(elementSnapshot),
        note:'Chat/Work are mode toggles, not model-picker buttons; no click attempted'});
      throw new Error('当前页面没有可见的模型选择器；“聊天/工作”是模式切换控件，不是模型菜单');
    }
    const before=new Set([...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]')].filter(visible));
    const p=c.sort((a,b)=>{
      const ad=(a.getAttribute('data-testid')||'').toLowerCase(),bd=(b.getAttribute('data-testid')||'').toLowerCase();
      return (bd.includes('model')?2:0)-(ad.includes('model')?2:0);
    })[0];
    click(p); await WAIT(800);
    const overlays=[...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]')].filter(visible);
    let root=overlays.find(x=>!before.has(x)) || overlays.at(-1);
    if(!root){
      const popupCandidates=[...document.querySelectorAll('[data-radix-popper-content-wrapper],[data-radix-menu-content],[data-state="open"]')]
        .filter(visible).filter(el=>!inSidebar(el)).filter(el=>el.querySelector('button,[role="menuitem"],[role="option"],[role="radio"]'));
      root=popupCandidates.at(-1)||null;
    }
    diagnostic('picker_opened',root?'info':'error',{button:elementSnapshot(p),root:elementSnapshot(root)});
    if(!root)throw new Error('点击模型选择器后没有发现模型菜单/弹层');
    if(inSidebar(root))throw new Error('安全停止：检测到左侧聊天栏菜单，拒绝继续点击');
    return {button:p,root};
  }
  function composer(){
    const sels=['#prompt-textarea','textarea','[contenteditable="true"][data-lexical-editor="true"]','[contenteditable="true"]'];
    return sels.flatMap(s=>[...document.querySelectorAll(s)]).find(el=>visible(el)&&!inSidebar(el))||null;
  }
  function composerSnapshot(){ return elementSnapshot(composer()); }
  function urlSnapshot(){ return {href:location.href,pathname:location.pathname}; }
  async function waitConversationTransition(beforeUrl,beforeAssist,timeout=30000){
    const started=Date.now(); let last={};
    while(Date.now()-started<timeout){
      if(window.__MODELPRO_STOP__)throw new Error('stopped_by_user');
      const state={url:urlSnapshot(),assistantCount:assistantBlocks().length,composer:composerSnapshot(),pickers:pickerCandidates().map(elementSnapshot)};
      last=state;
      if(location.href!==beforeUrl || state.assistantCount>beforeAssist || state.pickers.length){
        diagnostic('conversation_transition','info',{elapsedMs:Date.now()-started,...state});
        return state;
      }
      await WAIT(300);
    }
    diagnostic('conversation_transition','warn',{elapsedMs:Date.now()-started,...last});
    return last;
  }
  async function bootstrapConversationDiscovery(){
    const modes=modeControls(), chat=modes.find(x=>/^(聊天|chat)$/i.test(textOf(x)));
    diagnostic('conversation_bootstrap','info',{urlBefore:urlSnapshot(),modeControls:modes.map(elementSnapshot),composer:composerSnapshot()});
    if(chat && chat.getAttribute('aria-checked')!=='true' && chat.getAttribute('data-state')!=='checked'){
      click(chat); await WAIT(350);
      diagnostic('chat_mode_selected','info',{control:elementSnapshot(chat)});
    }
    const p=probe(1,1),beforeUrl=location.href,beforeAssist=assistantBlocks().length;
    const prompt=MARKER+' 会话发现：'+p.text;
    log('info','bootstrap_probe_prepared',{prompt,expectedValue:p.expectedValue,beforeUrl,beforeAssist});
    await sendPrompt(prompt);
    diagnostic('bootstrap_probe_sent','info',{urlImmediatelyAfter:location.href,composer:composerSnapshot()});
    const transition=await waitConversationTransition(beforeUrl,beforeAssist);
    // If a new assistant turn already exists, bind directly to that turn. Passing beforeAssist
    // here would require a fourth block and can wait forever after the third block already appeared.
    const afterTransitionBlocks=assistantBlocks();
    let ans;
    if(afterTransitionBlocks.length>beforeAssist){
      const target=afterTransitionBlocks[afterTransitionBlocks.length-1];
      diagnostic('bootstrap_answer_binding','info',{beforeAssist,afterTransitionCount:afterTransitionBlocks.length,binding:'existing_new_turn',target:elementSnapshot(target),transition});
      ans=await waitBoundAssistantAnswer(p.expectedValue,target,60000);
    }else{
      diagnostic('bootstrap_answer_binding','info',{beforeAssist,afterTransitionCount:afterTransitionBlocks.length,binding:'wait_for_new_turn',transition});
      ans=await waitAnswer(p.expectedValue,beforeAssist,60000);
    }
    report.bootstrap={probe:p,answer:ans.answer,answerExcerpt:ans.text,probeAnswerConfirmed:ans.ok,timedOut:ans.timedOut===true,urlAfter:location.href};
    log(ans.ok?'info':'warn','bootstrap_probe_result',report.bootstrap);
    await WAIT(500);
    captureUiDiagnostic('post_conversation_ui_snapshot');
    const post=pickerCandidates();
    diagnostic('post_conversation_picker_candidates',post.length?'info':'warn',{count:post.length,candidates:post.map(elementSnapshot),modeControls:modeControls().map(elementSnapshot),url:urlSnapshot()});
    return post;
  }
  function menuModelRows(root){
    if(!root||!visible(root))return[];
    if(inSidebar(root))throw new Error('catalog_discovery_invalid: 模型菜单根节点位于左侧聊天栏');
    const items=[...root.querySelectorAll('[role="menuitem"],[role="option"],[role="radio"],button,[role="button"]')]
      .filter(visible).filter(el=>!inSidebar(el)),rows=[];
    for(const el of items){
      const label=textOf(el);
      if(!label||label.length>120||invalidModelLabel(label))continue;
      if(!/(GPT|ChatGPT|Astra|Sol|Pro|Luna|Terra|o\d)/i.test(label))continue;
      if(/upgrade|plan|设置|settings|new chat|temporary|send|发送/i.test(label))continue;
      rows.push({label,el});
    }
    const seen=new Set();
    return rows.filter(r=>{const k=r.label.toLowerCase();if(seen.has(k))return false;seen.add(k);return true});
  }
  async function discover(){ const opened=await openPicker(); const rows=menuModelRows(opened.root); if(!rows.length){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));throw new Error('模型菜单已打开，但未发现可识别模型项');} report.discoveredModels=rows.map(r=>({label:r.label})).sort(compare);
    if(report.discoveredModels.some(x=>invalidModelLabel(x.label))) throw new Error('catalog_discovery_invalid: 发现会话导航项，已停止以防误测试'); log('info','models_discovered',{models:report.discoveredModels.map(x=>x.label)}); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await WAIT(300); return report.discoveredModels; }
  async function selectModel(label){ const opened=await openPicker(); const rows=menuModelRows(opened.root),low=label.toLowerCase(); const row=rows.find(r=>r.label===label)||rows.find(r=>r.label.toLowerCase().includes(low)||low.includes(r.label.toLowerCase())); if(!row)throw new Error('模型菜单中找不到: '+label); click(row.el); await WAIT(900); log('info','model_selected',{label}); }
  function diagnostic(stage,status,details={}){
    const row={ts:now(),stage,status,details}; diagnostics.push(row);
    log(status==='error'?'error':status==='warn'?'warn':'info','diagnostic_'+stage,row);
    return row;
  }
  function safeAttr(el,name){ try{return el?.getAttribute?.(name)||''}catch{return''} }
  function elementSnapshot(el){
    if(!el)return null; const r=el.getBoundingClientRect();
    return {tag:el.tagName,id:el.id||'',text:textOf(el).slice(0,160),
      ariaLabel:safeAttr(el,'aria-label'),testId:safeAttr(el,'data-testid'),role:safeAttr(el,'role'),
      rect:{left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},
      inSidebar:inSidebar(el)};
  }
  function captureUiDiagnostic(stage){
    const els=[...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[role="option"]')]
      .filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.top<220})
      .slice(0,120).map(elementSnapshot);
    diagnostic(stage,'info',{visibleTopControls:els,viewport:{width:innerWidth,height:innerHeight}});
  }
  function buildLogText(){
    const lines=[];
    lines.push('ModelPro Browser Console Verifier LOG');
    lines.push('version='+VERSION);
    lines.push('startedAt='+report.startedAt);
    lines.push('completedAt='+(report.completedAt||''));
    lines.push('finishReason='+(report.finishReason||''));
    lines.push('outcome='+(report.summary?.outcome||''));
    lines.push('url='+location.href);
    lines.push('userAgent='+navigator.userAgent);
    lines.push('');
    lines.push('=== DIAGNOSTICS ===');
    for(const d of diagnostics) lines.push(JSON.stringify(d));
    lines.push('');
    lines.push('=== EVENT LOG ===');
    for(const l of logs) lines.push(JSON.stringify(l));
    lines.push('');
    lines.push('=== RESULTS ===');
    for(const r of report.results) lines.push(JSON.stringify(r));
    if(report.fatalError){lines.push('');lines.push('=== FATAL ERROR ===');lines.push(String(report.fatalError));}
    return lines.join('\r\n');
  }
  function downloadText(text,name){
    const blob=new Blob([text],{type:'text/plain;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
    document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),3000);
  }
  function download(obj){ const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}); const a=document.createElement('a'),stamp=new Date().toISOString().replace(/[:.]/g,'-'); a.href=URL.createObjectURL(blob); a.download='ModelPro-Browser-Report-'+stamp+'.json'; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),3000); }
  function finalize(reason='completed'){
    if(finalized)return; finalized=true; report.completedAt=now(); report.finishReason=reason;
    report.summary={total:report.discoveredModels.length,completed:report.results.length,passed:report.results.filter(x=>x.probeAnswerConfirmed).length,failed:report.results.filter(x=>!x.probeAnswerConfirmed).length,backendServedModelConfirmed:0,outcome:reason==='fatal_error'?'browser_probe_error':
        (report.discoveredModels.length>0&&report.results.length===report.discoveredModels.length&&report.results.every(x=>x.probeAnswerConfirmed)?'browser_probe_pass':'browser_probe_incomplete')};
    log('info','verification_finished',report.summary);
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    if(emergencyLogTimer){clearInterval(emergencyLogTimer);emergencyLogTimer=null;}
    exportLog(reason); if(statusEl){
      const err=report.fatalError?'\n错误：'+String(report.fatalError).split('\n')[0].replace(/^Error:\s*/,''):'';
      statusEl.textContent+='\n\n'+(reason==='fatal_error'?'测试报错':'完成')+'：'+report.summary.outcome+err+'\nLOG 已自动下载';
    } window.__MODELPRO_REPORT__=report;
  }
  try{
    if(location.hostname!=='chatgpt.com')throw new Error('请在 https://chatgpt.com/ 页面运行');
    window.__MODELPRO_STOP__=true;
    document.querySelectorAll('#modelpro-browser-panel').forEach(el=>el.remove());
    await WAIT(150);
    window.__MODELPRO_STOP__=false; makePanel(); armEmergencyExport();
    window.addEventListener('pagehide',()=>exportLog('pagehide'),{once:true});
    window.addEventListener('beforeunload',()=>exportLog('beforeunload'),{once:true});
    console.log('%cModelPro '+VERSION,'font-size:18px;font-weight:bold;color:#16a34a');
    log('info','verification_started',{version:VERSION,safety:'sidebar-excluded'});
    captureUiDiagnostic('startup_ui_snapshot');
    let models=[];
    if(pickerCandidates().length){
      models=await discover();
    }else{
      await bootstrapConversationDiscovery();
      if(pickerCandidates().length) models=await discover();
      else {
        report.discoveredModels=[{label:'current-conversation-model',discovery:'conversation-driven',selectable:false}];
        models=report.discoveredModels;
        diagnostic('catalog_fallback','warn',{reason:'no_visible_model_picker_after_real_conversation',models});
      }
    }
    if(!models.length)throw new Error('未发现可验证模型');
    for(let i=0;i<models.length;i++){
      if(window.__MODELPRO_STOP__)break;
      const model=models[i],result={ordinal:i+1,label:model.label,startedAt:now(),uiSelected:false,probeAnswerConfirmed:false,backendServedModelConfirmed:false,backendEvidence:'not_available_in_page_console'};
      try{ if(model.selectable!==false){await selectModel(model.label); result.uiSelected=true;} else {result.uiSelected=null; result.selectionSkipped='no_visible_model_picker';}
        const p=probe(i+1,models.length); result.probe=p; const before=assistantBlocks().length; await sendPrompt(p.text); const ans=await waitAnswer(p.expectedValue,before); result.answer=ans.answer; result.answerExcerpt=ans.text; result.probeAnswerConfirmed=ans.ok; result.timedOut=ans.timedOut===true; if(!ans.ok)result.error=ans.timedOut?'response_timeout':'unexpected_answer:'+ans.answer; }
      catch(e){ result.error=e?.message||String(e); log('error','model_verification_error',{model:model.label,error:result.error}); }
      result.completedAt=now(); report.results.push(result); log(result.probeAnswerConfirmed?'info':'warn','model_verification_result',result);
    }
    finalize(window.__MODELPRO_STOP__?'stopped_by_user':'completed');
  }catch(e){ report.fatalError=e?.stack||String(e);
    captureUiDiagnostic('fatal_ui_snapshot');
    diagnostic('fatal_chain','error',{message:e?.message||String(e),stack:e?.stack||'',discoveredModels:report.discoveredModels.length,completedResults:report.results.length});
    log('error','fatal',{error:report.fatalError}); finalize('fatal_error'); }
})();