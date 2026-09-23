import { DeliveryError } from './adapters.mjs';
export function createWorker(config,store,publish){
  let busy=false,timer;const {db}=store;
  async function tick(){
    if(busy||config.previewOnly)return;busy=true;
    try{
      const row=db.prepare("SELECT d.*,p.owner,p.created,p.payload FROM deliveries d JOIN posts p ON p.id=d.post_id WHERE d.status IN ('queued','retrying') AND d.due<=? ORDER BY d.due,d.id LIMIT 1").get(Date.now());
      if(!row)return;
      if(!config.allowed.has(row.owner)){db.prepare("UPDATE deliveries SET status='cancelled',error='Account is no longer allowed' WHERE id=?").run(row.id);return;}
      const connection=row.platform==='nostr'?null:store.connection(row.owner,row.platform);
      if(row.platform!=='nostr'&&(!connection||connection.identity!==row.identity)){db.prepare("UPDATE deliveries SET status='failed',error='Linked identity changed or was disconnected. Create a new post for a different identity.' WHERE id=?").run(row.id);return;}
      const post={...JSON.parse(row.payload),id:row.post_id,owner:row.owner,created:row.created},media=post.mediaId?db.prepare('SELECT * FROM media WHERE id=? AND owner=?').get(post.mediaId,row.owner):null;
      db.prepare("UPDATE deliveries SET status='working',attempts=attempts+1,error=NULL WHERE id=?").run(row.id);
      const context={checkpoint:JSON.parse(row.checkpoint),save(value){this.checkpoint={...this.checkpoint,...value};db.prepare('UPDATE deliveries SET checkpoint=? WHERE id=?').run(JSON.stringify(this.checkpoint),row.id);},markPublishing(){db.prepare("UPDATE deliveries SET status='publishing' WHERE id=?").run(row.id);}};
      try{const result=await publish(row.platform,post,connection,media,context);db.prepare("UPDATE deliveries SET status='posted',result=?,error=NULL WHERE id=?").run(JSON.stringify(result),row.id);}
      catch(error){const publishing=db.prepare('SELECT status FROM deliveries WHERE id=?').get(row.id)?.status==='publishing';let status=error instanceof DeliveryError?error.state:publishing?'uncertain':'failed';if(status==='retrying'&&row.attempts>=7)status='failed';db.prepare('UPDATE deliveries SET status=?,due=?,error=? WHERE id=?').run(status,Date.now()+(error.delay||30000),error instanceof DeliveryError?error.message:'Delivery failed unexpectedly. Inspect the destination before retrying.',row.id);}
    }finally{busy=false;}
  }
  return {tick,start(){timer=setInterval(()=>tick().catch(()=>console.error('Crosspost worker could not process its queue')),1000);},stop(){clearInterval(timer);}};
}
