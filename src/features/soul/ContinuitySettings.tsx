import { useCallback, useEffect, useState } from "react";
import { runCommand } from "../app/appRuntime";
import { useTranslation } from "../i18n/I18nProvider";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";
type Proposal={id:string;field:string;before:unknown;after:unknown;evidence_count:number};
type History={revision:number;history_enabled:boolean;days:number;nickname:string|null;nickname_options:string[];milestones:string[];proposals:Proposal[];versions:{id:string;revision:number;snapshot:string;created_at:number}[]};
function description(value:unknown):string{return value==null?"—":Array.isArray(value)?value.join("、"):String(value);}
export function ContinuitySettings({roleRevision,onChanged}:{roleRevision:number;onChanged:()=>void}){
 const {t,locale}=useTranslation();const toast=useToast();const [history,setHistory]=useState<History>();const [pending,setPending]=useState(false);
 const load=useCallback(()=>void runCommand<History>("soul_get_continuity").then(setHistory).catch(error=>toast.error(toUserMessage(error,t("soul.settings.loadFailed")))),[t,toast]);
 useEffect(load,[load]);
 async function action(command:string,args:Record<string,unknown>){
  setPending(true);try{await runCommand(command,args);load();onChanged();}catch(error){toast.error(toUserMessage(error,t("soul.settings.conflict")));}finally{setPending(false);}
 }
 if(!history)return null;
 return <div className="soul-continuity">
  <h4>{t("soul.continuity.title")}</h4>
  <label><input type="checkbox" disabled={pending} checked={history.history_enabled} onChange={event=>void action("soul_update_continuity",{expectedRevision:history.revision,historyEnabled:event.currentTarget.checked,nickname:null})}/>{t("soul.continuity.enabled")}</label>
  {history.history_enabled && <p>{t("soul.continuity.days").replace("{days}",String(history.days))}</p>}
  <ul>{history.milestones.map(key=><li key={key}>{t(`soul.continuity.milestones.${key}`)}</li>)}</ul>
  <label>{t("soul.continuity.nickname")}<select disabled={pending||!history.history_enabled} value={history.nickname??""} onChange={event=>void action("soul_update_continuity",{expectedRevision:history.revision,historyEnabled:history.history_enabled,nickname:event.currentTarget.value||null})}>
   <option value="">{t("soul.continuity.noNickname")}</option>{history.nickname_options.map(key=><option key={key} value={key}>{t(`soul.continuity.names.${key}`)}</option>)}
  </select></label>
  <p>{t("soul.continuity.nicknameHint")}</p>
  <h4>{t("soul.continuity.proposals")}</h4>
  {history.proposals.map(proposal=><article key={proposal.id}>
   <p>{t(`soul.settings.${proposal.field}`)}: {description(proposal.before)} → {description(proposal.after)}</p>
   <p>{t("soul.continuity.evidence").replace("{count}",String(proposal.evidence_count))}</p>
   {[true,false].map(approve=><button type="button" key={String(approve)} disabled={pending} onClick={()=>void action("soul_review_evolution",{id:proposal.id,approve,expectedRevision:roleRevision,locale})}>{t(approve?"soul.review.approve":"soul.review.reject")}</button>)}
  </article>)}
  <h4>{t("soul.continuity.versions")}</h4>
  <p>{t("soul.continuity.rollbackHint")}</p>
  {history.versions.map(version=><div key={version.id}><details><summary>{t("soul.continuity.version").replace("{revision}",String(version.revision))} · {new Date(version.created_at*1000).toLocaleString(locale)}</summary>{(()=>{try{const snapshot=JSON.parse(version.snapshot) as Record<string,unknown>;return <div><p>{t("soul.settings.tone")}: {description(snapshot.tone)}</p><p>{t("soul.settings.catchphrases")}: {description(snapshot.catchphrases)}</p></div>;}catch{return null;}})()}</details><button type="button" disabled={pending||version.revision===roleRevision} onClick={()=>{
   if(window.confirm(t("soul.continuity.rollbackConfirm")))void action("soul_rollback_evolution",{id:version.id,expectedRevision:roleRevision});
  }}>{t("soul.continuity.rollback")}</button></div>)}
 </div>;
}
