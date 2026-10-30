const crypto = require('node:crypto');
const mongoose = require('mongoose');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle,MessageFlags}=require('discord.js');
const cfg=require('./config');
const GUILD=cfg.guildId, TICKET_BOT=cfg.ticketsV2BotId; // legacy Tickets v2 openings are still picked up
const FIELD='roblox user that is receiving the r$';
function model(){
 if(mongoose.connection.readyState!==1)throw Error('Database unavailable');
 return mongoose.models.TicketRoblox || mongoose.model('TicketRoblox',new mongoose.Schema({
  _id:String,guildId:String,channelId:String,ownerId:String,openingId:String,promptId:String,
  robloxId:String,username:String,source:String,status:String,revision:String,oauthMatched:Boolean,
  accounts:[{robloxId:String,username:String,oauthMatched:Boolean}],suggestions:[String],
  confirmedAt:Date,createdAt:Date
 },{bufferCommands:false}));
}
function parseOpening(message){
 if(message.guildId!==GUILD || message.author?.id!==TICKET_BOT || !message.author.bot)return null;
 const embeds=message.embeds||[];
 const greetings=embeds.map(e=>String(e.description||'').replace(/\*/g,'').trim()).filter(s=>/^Hey\s+<@!?\d+>\s*!/.test(s));
 const owners=[...new Set(greetings.map(s=>s.match(/^Hey\s+<@!?(\d+)>/)[1]))];
 const fields=embeds.flatMap(e=>e.fields||[]).filter(f=>String(f.name).replace(/[\*`]/g,'').trim().replace(/:$/,'').toLowerCase()===FIELD);
 // Never guess the opener or treat a missing form as an empty answer.
 if(owners.length!==1 || fields.length!==1)return null;
 let input=String(fields[0].value||'').trim();
 if(/^(?:-|—|n\/a|none|not provided|no response)$/i.test(input))input='';
 return {ownerId:owners[0],input};
}
async function resolveUser(input){
 let value=String(input).trim();const url=value.match(/^https:\/\/(?:www\.)?roblox\.com\/users\/(\d+)\/(?:profile)?\/?(?:[?#].*)?$/i);
 if(url)value=url[1];let data;
 const request=async(url,options={})=>{const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Roblox lookup unavailable. Please try again.');return r.json();};
 if(/^\d{1,20}$/.test(value))data=await request('https://users.roblox.com/v1/users/'+value);
 else {value=value.replace(/^@/,'');if(!/^[a-z\d_]{3,20}$/i.test(value))throw Error('Enter one Roblox username, user ID, or profile link.');const result=await request('https://users.roblox.com/v1/usernames/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usernames:[value],excludeBannedUsers:false})});data=result.data?.[0];}
 if(!data||!/^\d{1,20}$/.test(String(data.id))||!/^[a-z\d_]{3,20}$/i.test(data.name||''))throw Error('Roblox account not found. Check the username and try again.');
 return {robloxId:String(data.id),username:data.name};
}
const linked=owner=>require('./RobloxLinks').linkedUser(owner);
function accountsOf(row){return row.accounts?.length?row.accounts:row.robloxId?[{robloxId:row.robloxId,username:row.username,oauthMatched:row.oauthMatched}]:[];}
async function resolveUsers(input){
 const users=await require('./PayoutRecipients').resolveRecipients(input);
 if(!users.length)throw Error('Enter at least one account.');
 return users.map(u=>({robloxId:String(u.id),username:u.name,oauthMatched:false}));
}
function payload(row,confirmed=false){
 const accounts=accountsOf(row);
 const account=accounts.length?accounts.map(u=>`[${u.username.replace(/_/g,'\\_')}](<https://www.roblox.com/users/${u.robloxId}/profile>)${confirmed&&u.oauthMatched?' (OAuth linked)':''}`).join(', '):null;
 const content=confirmed?`Roblox accounts confirmed for this ticket: ${account}\n${accounts.every(u=>u.oauthMatched)?'Matches the opener’s OAuth-linked account.':'Other accounts: ownership not verified.'}`:
 account?`<@${row.ownerId}> Use ${account} for this ticket?\n${row.source==='form'?'From your ticket form.':row.source==='oauth'?'From your linked account.':'Manually entered account.'}`:
 `<@${row.ownerId}> Enter up to 10 Roblox accounts, separated by commas or spaces.${row.suggestions?.length?' Saved suggestions: '+row.suggestions.map(s=>'`'+s+'`').join(', ')+'. Choose saved accounts and keep only this ticket’s recipients.':''}`;
 const buttons=[];
 if(account&&!confirmed)buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel('Confirm all').setCustomId('ticket_rblx:confirm:'+row.revision));
 buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Change accounts').setCustomId('ticket_rblx:change:'+row.revision));
 if(row.suggestions?.length)buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Choose saved accounts').setCustomId('ticket_rblx:saved:'+row.revision));
 if(!confirmed)buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Use linked account').setCustomId('ticket_rblx:linked:'+row.revision));
 return {content,embeds:[],flags:MessageFlags.SuppressEmbeds,allowedMentions:{parse:[]},components:[new ActionRowBuilder().addComponents(buttons)]};
}
const busy=new Set();
async function onMessage(message){
 const parsed=parseOpening(message);if(!parsed)return;
 if(Date.now()-message.createdTimestamp>300000 || !message.channel?.isTextBased())return;
 return begin({guildId:message.guildId,channel:message.channel,ownerId:parsed.ownerId,input:parsed.input,openingId:message.id});
}
// Starts the recipient-confirmation prompt for a ticket. Used for Tickets v2
// openings (above) and directly by DealDesk's own tickets (Tickets.js).
async function begin({guildId,channel,ownerId,input:formInput,openingId}){
 formInput=String(formInput||'').trim();
 if(/^(?:-|—|n\/a|none|not provided|no response)$/i.test(formInput))formInput='';
 const key=guildId+':'+channel.id;if(busy.has(key))return;busy.add(key);
 try{
  const Store=model();if(await Store.exists({_id:key}))return;
  // A nonempty form value always wins, even if invalid or Roblox is unavailable.
  const input=formInput||await linked(ownerId);
  let accounts=[];try{if(input)accounts=await resolveUsers(input);}catch{}
  const settings=await require('./Datastores/UserSettings').findOne({user:ownerId}).lean();
  const suggestions=[...new Set((settings?.robloxUsernames||[]).filter(s=>/^[a-z\d_]{3,20}$/i.test(s)))].slice(0,10);
  const row={_id:key,guildId,channelId:channel.id,ownerId,openingId,
   accounts,suggestions,source:formInput?'form':input?'oauth':'manual',status:'pending',revision:crypto.randomBytes(12).toString('hex'),createdAt:new Date()};
  try{await Store.create(row);}catch(e){if(e.code===11000)return;throw e;}
  const body=payload(row);if(formInput&&!accounts.length)body.content=`<@${row.ownerId}> I could not resolve every account from your ticket form. Use **Change accounts** and enter up to 10 usernames, IDs or profile links, separated by commas or spaces.`;
  try{const sent=await channel.send({...body,nonce:openingId,enforceNonce:true});await Store.updateOne({_id:key},{$set:{promptId:sent.id}});}
  catch{await Store.updateOne({_id:key},{$set:{status:'send_failed'}});console.error('Ticket Roblox prompt could not be sent');}
 }catch{console.error('Ticket Roblox integration unavailable');}finally{busy.delete(key);}
}
async function handle(i){
 const parts=i.customId.split(':');const action=parts[1],revision=parts[2];
 const deny=content=>i.reply({content,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
 try{
  if(i.guildId!==GUILD)return deny('This ticket integration is not enabled here.');
  const Store=model(), key=i.guildId+':'+i.channelId;const row=await Store.findById(key).lean();
  if(!row||row.ownerId!==i.user.id)return deny('Only the ticket opener can choose this account.');
  if(row.revision!==revision || (i.isButton()&&row.promptId!==i.message.id))return deny('This choice is outdated. Use the latest ticket account message.');
  if((action==='change'||action==='saved')&&i.isButton()){
   const input=new TextInputBuilder().setCustomId('account').setLabel('Recipients only: names, IDs or profile links').setPlaceholder('UserOne, UserTwo (up to 10; remove others)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500);
   const initial=action==='saved'?(row.suggestions||[]).join(', '):accountsOf(row).map(u=>u.username).join(', ');
   if(initial)input.setValue(initial);
   return i.showModal(new ModalBuilder().setCustomId('ticket_rblx:submit:'+revision).setTitle('Choose ticket recipients').addComponents(new ActionRowBuilder().addComponents(input)));
  }
  await i.deferReply({flags:MessageFlags.Ephemeral});
  const filter={_id:key,ownerId:i.user.id,revision};let change;
  if(action==='confirm'&&i.isButton()){
   if(!accountsOf(row).length || row.status!=='pending')return i.editReply('There are no pending accounts to confirm.');
   const current=await linked(row.ownerId);
   change={accounts:accountsOf(row).map(u=>({...u,oauthMatched:current===u.robloxId})),robloxId:null,username:null,status:'confirmed',confirmedAt:new Date(),oauthMatched:false,revision:crypto.randomBytes(12).toString('hex')};
  }else if((action==='submit'&&i.isModalSubmit())||(action==='linked'&&i.isButton())){
   const input=action==='submit'?i.fields.getTextInputValue('account'):await linked(row.ownerId);
   if(!input)return i.editReply('Use /link to connect your Roblox account, then try this button again.');
   let accounts;try{accounts=await resolveUsers(input);}catch{return i.editReply('Could not resolve every recipient. Enter up to 10 valid usernames, IDs or profile links separated by commas or spaces. No accounts were changed.');}
   change={accounts,robloxId:null,username:null,source:action==='submit'?'manual':'oauth',status:'pending',oauthMatched:false,confirmedAt:null,revision:crypto.randomBytes(12).toString('hex')};
  }else return i.editReply('Unsupported ticket action.');
  const result=await Store.updateOne(filter,{$set:change});if(!result.modifiedCount)return i.editReply('The account changed while you were choosing. Use the latest message.');
  const updated={...row,...change};
  try{await i.channel.messages.edit(row.promptId,payload(updated,updated.status==='confirmed'));}catch{return i.editReply('Your selection was saved, but the ticket message could not be updated. Ask staff to check bot permissions.');}
  return i.editReply(updated.status==='confirmed'?'Accounts confirmed for this ticket.':'Accounts selected. Review the ticket message and press Confirm all.');
 }catch(e){const content='Could not update the ticket account. Please try again.';if(i.deferred||i.replied)return i.editReply(content).catch(()=>{});return deny(content).catch(()=>{});}
}
function install(client){
 client.on('messageCreate',onMessage);
 client.on('messageUpdate',(_old,message)=>{if(!message.partial)onMessage(message);});
 client.on('channelDelete',channel=>{if(channel.guildId===GUILD)model().deleteOne({_id:GUILD+':'+channel.id}).catch(()=>{});});
}
module.exports={parseOpening,resolveUser,resolveUsers,accountsOf,payload,onMessage,begin,handle,install};
