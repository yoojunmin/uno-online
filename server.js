const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ ok: true }));
const rooms = new Map();
const colors = ['red', 'blue', 'green', 'yellow'];
const labels = { red: '빨강', blue: '파랑', green: '초록', yellow: '노랑' };
const id = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const shuffle = a => { for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
// 100장 구성: 컬러 카드 95장, 검은 카드 5장 (덱 구성 기준 5%).
function makeDeck() {
  const d=[]; let n=0; const add=(color,value)=>d.push({id:`c${n++}`,color,value});
  for (const c of colors) {
    add(c,'0');
    for (const v of ['1','2','3','4','5','6','7','8','9','skip','draw2','reverse']) { add(c,v); add(c,v); }
  }
  // 기본 색상 카드 중 5장을 덜어 총 95장으로 맞춘 뒤 검은 카드 5장을 더한다.
  for (const c of colors) { const ix=d.findIndex(x=>x.color===c&&x.value==='9'); if(ix>=0)d.splice(ix,1); }
  d.splice(d.findIndex(x=>x.color==='yellow'&&x.value==='8'),1);
  for(let i=0;i<3;i++) add('wild','wild');
  for(let i=0;i<2;i++) add('wild','wild4');
  return shuffle(d);
}
function publicState(room) {
  const current=room.players[room.turn];
  return { id:room.id, status:room.status, players:room.players.map((p,i)=>({id:p.id,name:p.name,count:p.hand.length,host:i===0,connected:p.connected})),
    turn:current?.id, drawnCard:current?.justDrawn, top:room.discard.at(-1), direction:room.direction, chosenColor:room.chosenColor,
    log:room.log.slice(-12), winner:room.winner, pending:room.pending?{amount:room.pending.amount,target:room.pending.target}:null };
}
function sendRoom(room) { io.to(room.id).emit('state',publicState(room)); for(const p of room.players) if(p.connected) io.to(p.id).emit('hand',p.hand); }
function say(room,text) { room.log.push(text); if(room.log.length>40) room.log.shift(); }
function draw(room,player,count=1) {
  const cards=[];
  for(let i=0;i<count;i++) { if(!room.deck.length) { if(room.discard.length<=1) break; const top=room.discard.pop(); room.deck=shuffle(room.discard.splice(0)); room.discard=[top]; } const c=room.deck.pop(); if(c) { player.hand.push(c); cards.push(c); } }
  return cards;
}
function nextIndex(room, steps=1) { room.turn=(room.turn+room.direction*steps+room.players.length*steps)%room.players.length; }
function start(room) {
  room.deck=makeDeck(); room.discard=[]; room.direction=1; room.chosenColor=null; room.pending=null; room.winner=null;
  for(const p of room.players) p.hand=[];
  for(let i=0;i<7;i++) for(const p of room.players) draw(room,p);
  let first=room.deck.pop(); while(first?.color==='wild') { room.deck.unshift(first); first=room.deck.pop(); }
  room.discard.push(first); room.turn=0; room.status='playing'; room.log=[];
  say(room,`${room.players[0].name}님이 게임을 시작했습니다.`);
  if(first.value==='skip') { say(room,`${room.players[0].name}님의 턴을 건너뜁니다.`); nextIndex(room); }
  if(first.value==='draw2') { nextIndex(room); const p=room.players[room.turn]; draw(room,p,2); say(room,`${p.name}님이 +2를 받고 턴을 건너뜁니다.`); nextIndex(room); }
  sendRoom(room);
}
function leave(socket) {
  const rid=socket.data.room; if(!rid) return;
  const room=rooms.get(rid); socket.data.room=null; if(!room) return;
  const idx=room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
  const [p]=room.players.splice(idx,1); socket.leave(rid);
  if(room.players.length===0) rooms.delete(rid);
  else if(room.status==='playing') { if(idx<room.turn) room.turn--; if(room.turn>=room.players.length) room.turn=0; if(room.players.length<2) { room.status='waiting'; room.log=[]; say(room,'상대 플레이어가 나가 게임이 종료되었습니다.'); } else say(room,`${p.name}님이 나갔습니다.`); sendRoom(room); }
  else sendRoom(room);
}
io.on('connection', socket => {
  socket.on('create', ({name}, cb=()=>{}) => {
    leave(socket); const room={id:id(),players:[{id:socket.id,name:String(name||'플레이어').slice(0,16),hand:[],connected:true}],status:'waiting',log:[],turn:0,direction:1,discard:[],deck:[]};
    rooms.set(room.id,room); socket.join(room.id); socket.data.room=room.id; sendRoom(room); cb({ok:true,code:room.id});
  });
  socket.on('join', ({name,code}, cb=()=>{}) => {
    leave(socket); const room=rooms.get(String(code||'').trim().toUpperCase());
    if(!room) return cb({ok:false,error:'방을 찾을 수 없습니다.'});
    if(room.status!=='waiting') return cb({ok:false,error:'이미 게임이 시작된 방입니다.'});
    if(room.players.length>=4) return cb({ok:false,error:'방이 가득 찼습니다.'});
    room.players.push({id:socket.id,name:String(name||'플레이어').slice(0,16),hand:[],connected:true}); socket.join(room.id); socket.data.room=room.id; sendRoom(room); cb({ok:true,code:room.id});
  });
  socket.on('quick', ({name}, cb=()=>{}) => {
    leave(socket); let room=[...rooms.values()].find(r=>r.status==='waiting'&&r.players.length<4);
    if(!room) { room={id:id(),players:[],status:'waiting',log:[],turn:0,direction:1,discard:[],deck:[]}; rooms.set(room.id,room); }
    room.players.push({id:socket.id,name:String(name||'플레이어').slice(0,16),hand:[],connected:true}); socket.join(room.id); socket.data.room=room.id; sendRoom(room); cb({ok:true,code:room.id});
  });
  socket.on('start', (cb=()=>{}) => {
    const room=rooms.get(socket.data.room); if(!room) return;
    if(room.players[0]?.id!==socket.id) return cb({ok:false,error:'방장만 시작할 수 있습니다.'});
    if(room.players.length<2) return cb({ok:false,error:'게임을 시작하려면 2명 이상이 필요합니다.'});
    start(room); cb({ok:true});
  });
  socket.on('play', ({cardId,color}, cb=()=>{}) => {
    const room=rooms.get(socket.data.room); if(!room||room.status!=='playing') return;
    const p=room.players[room.turn]; if(p?.id!==socket.id) return cb({ok:false,error:'내 차례가 아닙니다.'});
    const ix=p.hand.findIndex(c=>c.id===cardId); if(ix<0) return cb({ok:false,error:'카드를 찾을 수 없습니다.'});
    const card=p.hand[ix], top=room.discard.at(-1), active=room.chosenColor||top.color;
    if(p.justDrawn&&p.justDrawn!==cardId) return cb({ok:false,error:'방금 뽑은 카드만 낼 수 있습니다.'});
    if(card.value==='wild4'&&p.hand.some(c=>c.color===active)) return cb({ok:false,error:'현재 색과 같은 카드가 있으면 +4를 낼 수 없습니다.'});
    if(card.color!=='wild'&&card.color!==active&&card.value!==top.value) return cb({ok:false,error:'색 또는 숫자/기호가 맞는 카드만 낼 수 있습니다.'});
    if(card.color==='wild'&&!colors.includes(color)) return cb({ok:false,error:'색을 선택해주세요.'});
    p.hand.splice(ix,1); delete p.justDrawn; room.discard.push(card); room.chosenColor=card.color==='wild'?color:null;
    say(room,`${p.name}님이 ${card.color==='wild'?(card.value==='wild4'?'+4 색 바꾸기':'색 바꾸기'):`${labels[card.color]} ${card.value==='skip'?'정지':card.value==='draw2'?'+2':card.value}`} 카드를 냈습니다.${card.color==='wild'?` ${labels[color]} 선택`:''}`);
    if(p.hand.length===0) { room.status='finished'; room.winner=p.name; say(room,`${p.name}님이 승리했습니다!`); sendRoom(room); return cb({ok:true}); }
    nextIndex(room);
    let target=room.players[room.turn];
    if(card.value==='skip') { say(room,`${target.name}님의 턴을 건너뜁니다.`); nextIndex(room); }
    else if(card.value==='draw2'||card.value==='wild4') { const amount=card.value==='draw2'?2:4; target=room.players[room.turn]; draw(room,target,amount); say(room,`${target.name}님이 ${amount}장을 받고 턴을 건너뜁니다.`); nextIndex(room); }
    else if(card.value==='reverse') { room.direction*=-1; if(room.players.length===2) nextIndex(room); }
    sendRoom(room); cb({ok:true});
  });
  socket.on('draw', (cb=()=>{}) => {
    const room=rooms.get(socket.data.room); if(!room||room.status!=='playing') return;
    const p=room.players[room.turn]; if(p?.id!==socket.id) return cb({ok:false,error:'내 차례가 아닙니다.'});
    if(p.justDrawn) return cb({ok:false,error:'뽑은 카드를 내거나 턴을 넘겨주세요.'});
    const cards=draw(room,p); say(room,`${p.name}님이 카드를 한 장 뽑았습니다.`);
    if(cards.length) p.justDrawn=cards[0].id;
    sendRoom(room); cb({ok:true,canPlay:cards.length>0});
  });
  socket.on('pass', cb=>{ const room=rooms.get(socket.data.room); if(!room||room.status!=='playing') return; const p=room.players[room.turn]; if(p?.id!==socket.id) return cb?.({ok:false}); if(!p.justDrawn) return cb?.({ok:false,error:'먼저 카드를 뽑아주세요.'}); delete p.justDrawn; say(room,`${p.name}님이 턴을 넘겼습니다.`); nextIndex(room); sendRoom(room); cb?.({ok:true}); });
  socket.on('chat', text=>{ const room=rooms.get(socket.data.room),p=room?.players.find(x=>x.id===socket.id); if(!p) return; const message=String(text||'').trim().slice(0,240); if(message) io.to(room.id).emit('chat',{name:p.name,text:message,time:new Date().toISOString()}); });
  socket.on('disconnect',()=>leave(socket));
});
const port=process.env.PORT||3000;
server.listen(port,'0.0.0.0',()=>console.log(`UNO server listening on ${port}`));
