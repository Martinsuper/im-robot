import test from "node:test";
import assert from "node:assert/strict";
import { fixture, stream, toolResponse } from "./test-support.mjs";
const tool = { type: "function", function: { name: "piko_focus__start_focus", description: "开始专注，由桌面确认后执行", parameters: { type: "object", properties: { minutes: { type: "integer", enum: [15, 25, 45, 60] } }, required: ["minutes"] } } };
test("Passport focus request reaches the native app bridge and waits for its confirmed result", async t => {
  let requested = false;
  const f = await fixture(t, (_request, res, requests) => requests.length === 1
    ? toolResponse(res, tool.function.name, { minutes: 25 })
    : stream(res, { role: "assistant", content: "已开始25分钟专注。" }));
  const events = await f.run({ requestId: "passport-confirmed-focus", conversationId: "passport-device", prompt: "开始25分钟专注", unified: true, workspace: null, businessTools: [tool], onEvent(event, send) {
    if (event.type !== "app-tool") return;
    requested = true;
    assert.equal(event.name, tool.function.name);
    assert.equal(f.requests.length, 1, "No completion before the native app resolves the operation");
    setTimeout(() => send({ type: "app-result", callId: event.callId, result: { message: "专注计时状态已更新。", result: { status: "running", kind: "focus", remainingSeconds: 1500 } } }), 50);
  } });
  assert.ok(requested); assert.equal(events.at(-1).type, "completed");
  assert.ok(JSON.stringify(f.requests.at(-1)).includes("remainingSeconds"));
});
test("Passport task cancellation while awaiting a native operation does not report completion", async t => {
  const f = await fixture(t, (_request, res) => toolResponse(res, tool.function.name, { minutes: 25 }));
  const events = await f.run({ requestId: "passport-cancel-focus", conversationId: "passport-device", unified: true, workspace: null, businessTools: [tool], onEvent(event, send) {
    if (event.type === "app-tool") send({ type: "cancel" });
  } });
  assert.equal(events.at(-1).type, "cancelled"); assert.equal(f.requests.length, 1);
});

const calendarTool={type:"function",function:{name:"piko_calendar__create_event",description:"创建日程，必须先确认",parameters:{type:"object",properties:{title:{type:"string"},startAt:{type:"string"},endAt:{type:"string"}},required:["title","startAt","endAt"]}}};

test("Passport calendar uses the business bridge without asking for a workspace",async t=>{
  const f=await fixture(t,(_request,res,requests)=>requests.length===1
    ?toolResponse(res,calendarTool.function.name,{title:"评审",startAt:"2026-10-25T09:00:00+08:00",endAt:"2026-10-25T10:00:00+08:00"})
    :stream(res,{role:"assistant",content:"日程已创建。"}));
  const events=await f.run({passport:true,unified:true,workspace:null,businessTools:[calendarTool],onEvent(event,send){
    if(event.type==="app-tool"){
      assert.equal(event.name,calendarTool.function.name);
      send({type:"app-result",callId:event.callId,result:{id:"confirmed-event",created:true}});
    }
  }});
  assert.equal(events.at(-1).type,"completed");
  assert.ok(!f.requests[0].tools.some(t=>["bash","read","write"].includes(t.function.name)));
  assert.ok(!events.some(e=>e.type==="app-tool"&&e.name==="piko_select_workspace"));
});

test("Passport generated files use the default directory but still require write approval",async t=>{
  const {mkdir,readFile}=await import("node:fs/promises");const path=await import("node:path");
  const f=await fixture(t,(_request,res,requests)=>{
    if(requests.length===1)return toolResponse(res,"piko_select_workspace",{purpose:"generated-files"});
    if(requests.length===2)return toolResponse(res,"write",{path:"reply.txt",content:"GENERATED_CONTENT"});
    stream(res,{role:"assistant",content:"已保存到 Piko 文件夹。"});
  });
  const directory=path.join(f.root,"Documents","Piko");await mkdir(directory,{recursive:true});let approved=false;
  const events=await f.run({passport:true,unified:true,workspace:null,onEvent(event,send){
    if(event.type==="app-tool"){
      assert.equal(event.name,"piko_select_workspace");assert.equal(event.arguments.purpose,"generated-files");
      send({type:"app-result",callId:event.callId,result:{path:directory,default:true}});
    }
    if(event.type==="approval"){approved=true;send({type:"approval",approvalId:event.approvalId,allowed:true});}
  }});
  assert.equal(events.at(-1).type,"completed");assert.ok(approved);
  assert.equal(await readFile(path.join(directory,"reply.txt"),"utf8"),"GENERATED_CONTENT");
});

test("Passport existing files explicitly request desktop selection and honour cancellation",async t=>{
  const f=await fixture(t,(_request,res,requests)=>requests.length===1
    ?toolResponse(res,"piko_select_workspace",{purpose:"existing-files"})
    :stream(res,{role:"assistant",content:"你取消了目录选择，未操作文件。"}));
  const events=await f.run({passport:true,unified:true,onEvent(event,send){
    if(event.type==="app-tool"){
      assert.equal(event.name,"piko_select_workspace");assert.equal(event.arguments.purpose,"existing-files");
      send({type:"app-result",callId:event.callId,error:"用户取消选择工作目录"});
    }
  }});
  assert.equal(events.at(-1).type,"completed");
  assert.ok(!f.requests[0].tools.some(t=>["bash","read","write"].includes(t.function.name)));
  assert.ok(!events.some(e=>e.type==="approval"));
});

test("new Passport sessions do not inherit previous chat messages",async t=>{
  const f=await fixture(t,(_request,res)=>stream(res,{role:"assistant",content:"收到。"}));
  await f.run({passport:true,unified:true,workspace:null,conversationId:"device-session-a",prompt:"SESSION_A_ONLY_74f9"});
  await f.run({passport:true,unified:true,workspace:null,conversationId:"device-session-a",prompt:"继续刚才的话题"});
  assert.ok(JSON.stringify(f.requests[1].messages).includes("SESSION_A_ONLY_74f9"));
  await f.run({passport:true,unified:true,workspace:null,conversationId:"device-session-b",prompt:"新的聊天"});
  assert.ok(!JSON.stringify(f.requests[2].messages).includes("SESSION_A_ONLY_74f9"));
});

test("Passport default directories never auto-approve a shell command",async t=>{
  const shell=process.platform==="win32"?"powershell":"bash";
  const f=await fixture(t,(_request,res,requests)=>{
    if(requests.length===1)return toolResponse(res,"piko_select_workspace",{purpose:"generated-files"});
    if(requests.length===2)return toolResponse(res,shell,{command:"echo SHOULD_NOT_RUN_9523"});
    stream(res,{role:"assistant",content:"命令未获授权，未执行。"});
  });
  let approvalSeen=false;
  const events=await f.run({passport:true,unified:true,workspace:null,autoApproveCommands:true,onEvent(event,send){
    if(event.type==="app-tool")send({type:"app-result",callId:event.callId,result:{path:f.cwd,default:true}});
    if(event.type==="approval"){approvalSeen=true;send({type:"approval",approvalId:event.approvalId,allowed:false});}
  }});
  assert.equal(events.at(-1).type,"completed");assert.ok(approvalSeen);
  const end=events.find(e=>e.type==="tool-end"&&e.tool===shell);assert.ok(end?.isError);
});
