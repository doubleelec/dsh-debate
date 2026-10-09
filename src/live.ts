/**
 * dsh-debate — 实况页 HTML(host 直出,不经 React/slot/CSS 缓存)。
 *
 * GET /dsh-debate/live?id=<sessionId> 返回本页:轮询同源 /dsh-debate/api/state,
 * 进度横幅 + 实录全文 + 成果地图,每 2s 刷新,新条目自动滚到底。
 * 纯静态 HTML+内联 JS,无外部依赖,window.open 新窗口打开即看。
 */

/** HTML 转义(实录原文进 innerHTML 前必须转义)。 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 实况页:按会话 id 拼装,query 里的 id 原样回填进轮询脚本。 */
export function renderLivePage(id: string): string {
  const safeId = esc(id)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>⚔ 辩论实况 ${safeId}</title>
<style>
body{background:#1b1b1b;color:#e8e8e8;font:14px/1.7 system-ui,sans-serif;margin:0;padding:16px 20px 60px}
#bar{position:sticky;top:0;background:#262626;border:1px solid #555;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-weight:600}
#meta{color:#9a9a9a;font-size:12px;margin-bottom:12px;white-space:pre-wrap}
.turn{border:1px solid #444;background:#222;border-radius:10px;padding:10px 12px;margin:10px 0;white-space:pre-wrap;word-break:break-word}
.turn .who{font-weight:700;margin-bottom:6px;color:#9ecbff}
#map{border:1px solid #4176e6;background:#1e2a44;border-radius:10px;padding:12px 14px;margin-top:16px;white-space:pre-wrap;word-break:break-word}
#err{color:#ff7b7b;margin:8px 0;white-space:pre-wrap}
</style>
</head>
<body>
<div id="bar">⚔ 辩论实况 · <span id="st">连接中…</span></div>
<div id="meta"></div>
<div id="err"></div>
<div id="feed"></div>
<div id="mapwrap" style="display:none"><h3>成果地图</h3><div id="map"></div></div>
<script>
var ID=${JSON.stringify(id)};
var lastSeq=0;
// API 基址:从本页 URL 推导(经反向代理/子路径打开时,写死 /dsh-debate/... 会打到别处)。
// 本页路由是 <base>/dsh-debate/live,API 在 <base>/dsh-debate/api/*,取 live 前缀即基址。
var API_BASE=(function(){var p=window.location.pathname;var i=p.indexOf('/dsh-debate/live');return i>=0?p.slice(0,i):''})();
function e(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
async function poll(){
  try{
    var r=await fetch(API_BASE+'/dsh-debate/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID})});
    var s=await r.json();
    // 失败时标题栏也置位:否则 st 永远是"连接中…",看着像卡住(实为 unknown-id 或旧局)。
    if(!s.ok){document.getElementById('st').textContent='连接失败';document.getElementById('err').textContent='state 失败:'+(s.error||'unknown')+'(重启后旧局 id 作废,请回面板重开一局)';clearInterval(timer);return}
    document.getElementById('st').textContent=(s.status||'?')+(s.progress?(' · '+s.progress):'');
    var meta=[];
    if(s.auto)meta.push('问题:'+s.auto.question,'题型:'+s.auto.questionType+' · '+s.auto.lenses+' 个视角 · 背景 '+s.auto.contextChars+' 字'+(s.auto.targetCwd?(' · 目标:'+s.auto.targetCwd):''));
    meta.push('轮次:'+s.round);
    // 停机审计:stopReason + 每轮 agree/answer/引用命中/交棒字数(面板同款,host 本就返回)。
    if(s.stopReason)meta.push('停机:'+({convergence:'共识收敛',saturation:'覆盖饱和',maxRounds:'跑满',manual:'手动制图'}[s.stopReason]||s.stopReason));
    if(s.mode&&s.mode!=='resident')meta.push('驱动:'+s.mode);
    if(Array.isArray(s.rounds)&&s.rounds.length>0){
      for(var ri=0;ri<s.rounds.length;ri++){var r=s.rounds[ri];var q=r.quoteAudit||{};var hr=q.hitRate===null||q.hitRate===undefined?'—':(q.quotedLines+'/'+q.quotableLines);
        meta.push('R'+r.round+' B:'+(r.builderAgree?'✓':'✗')+(r.builderAnswer?('「'+String(r.builderAnswer).slice(0,18)+'」'):'')+' C:'+(r.challengerAgree?'✓':'✗')+(r.challengerAnswer?('「'+String(r.challengerAnswer).slice(0,18)+'」'):'')+(r.hasNewInfo?'':'·无新增')+' 引用'+hr+' 交棒'+r.builderRelayChars+'字');}
    }
    if(s.mirrorCount>0)meta.push('对话区镜像×'+s.mirrorCount);
    if(s.mirrorError)meta.push('镜像失败:'+s.mirrorError);
    // 实时流:正在写的各方当前 turn 流式文本(host 10s 发布一次,本页 2s 轮询即见)。
    if(s.streaming){for(var rk in s.streaming){var st=s.streaming[rk];if(st&&st.text){if(st.kind==='tools'){meta.push('[R'+st.round+' '+rk+' 调工具中] '+st.text);}else{var tail=String(st.text).split('\n').filter(function(l){return l.trim()!==''}).slice(-6).join('\n');meta.push('[R'+st.round+' ✍ '+rk+' 实时]\n'+tail+'▍');}}}}
    document.getElementById('meta').textContent=meta.join('\\n');
    if(s.error)document.getElementById('err').textContent=s.error;
    var feed=document.getElementById('feed');
    var isNew=false;
    for(var i=0;i<(s.transcript||[]).length;i++){
      var t=s.transcript[i];
      if(t.seq<=lastSeq)continue;
      lastSeq=t.seq;isNew=true;
      var div=document.createElement('div');div.className='turn';
      var who=document.createElement('div');who.className='who';who.textContent='[R'+t.round+' #'+t.seq+' '+t.role+']';
      var body=document.createElement('div');body.textContent=t.text;
      div.appendChild(who);div.appendChild(body);feed.appendChild(div);
    }
    if(s.mapText){document.getElementById('mapwrap').style.display='';document.getElementById('map').textContent=s.mapText}
    if(isNew)window.scrollTo(0,document.body.scrollHeight);
    if(s.status==='done'||s.status==='failed'||s.status==='stopped'){document.getElementById('st').textContent+='(结束)';clearInterval(timer)}
  }catch(err){document.getElementById('st').textContent='连接失败';document.getElementById('err').textContent='取 state 失败:'+String(err)+' · API 基址:'+API_BASE+'/dsh-debate/api/state(确认实况页与面板是同一服务同端口)'}
}
var timer=setInterval(poll,2000);poll();
</script>
</body>
</html>`
}
