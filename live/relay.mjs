import WebSocket from 'ws';

export async function publishToRelays(relays,event,timeoutMs=4000){
  const results=await Promise.all(relays.map(url=>new Promise(resolve=>{
    let done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);try{ws.close();}catch{}resolve({url,...value});};
    const ws=new WebSocket(url);
    const timer=setTimeout(()=>finish({ok:false,error:'timeout'}),timeoutMs);
    ws.on('open',()=>ws.send(JSON.stringify(['EVENT',event])));
    ws.on('message',raw=>{
      try{
        const msg=JSON.parse(String(raw));
        if(msg[0]==='OK'&&msg[1]===event.id)finish({ok:!!msg[2],error:msg[3]||''});
      }catch{}
    });
    ws.on('error',error=>finish({ok:false,error:error.message}));
  })));
  return {accepted:results.filter(x=>x.ok).length,results};
}
