'use strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Retry presentation only. Never rerun the action that produced the result.
async function editView(interaction,clean,message){
 let last;
 for(let attempt=0;attempt<3;attempt++){
  try{return await interaction.editReply(clean);}catch(error){last=error;if([10008,10015,50001,50013].includes(error.code))break;if(attempt<2)await sleep(300*(attempt+1));}
 }
 // A normal bot message can still be edited after the interaction token expires.
 if(message?.id && !interaction.ephemeral && interaction.channel?.messages?.edit){
  try{return await interaction.channel.messages.edit(message.id,clean);}catch(error){last=error;}
 }
 try{return await interaction.followUp({...clean,flags:64});}catch(error){
  console.error('[Result delivery] Failed:',last?.code||error.code||error.name);
  throw error;
 }
}
function showResult(interaction,payload,message){return editView(interaction,{content:'',embeds:[],components:[],...payload},message);}
module.exports={showResult,editView};
