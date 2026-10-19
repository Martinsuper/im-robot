// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SoulSettings } from "./SoulSettings";
import type { RoleSnapshot, SoulSettings as Settings } from "./types";
const state=vi.hoisted(()=>({command:vi.fn(),t:(key:string)=>key,toast:{error:vi.fn(),success:vi.fn()}}));
vi.mock("../app/appRuntime",()=>({isTauriRuntime:true,runCommand:state.command}));
vi.mock("../i18n/I18nProvider",()=>({useTranslation:()=>({t:state.t,locale:"ja-JP"})}));
vi.mock("../../components/feedback/toastStore",()=>({useToast:()=>state.toast}));
const role:RoleSnapshot={profile_id:"piko",schema_version:2,revision:4,default_resource_version:"1",locale:"ja-JP",user_overrides:{},effective:{background:"default",values:[],tone:"default",catchphrases:[],forbidden_phrases:[],care:"care",stance:"stance",extra:""},writable:true,fallback_reason:null};
const settings:Settings={revision:7,enabled:false,paused:false,enabled_since:100,categories:[{category:"greeting",enabled:false,available:true,enabled_since:null,daily_limit:2},{category:"pattern",enabled:false,available:false,enabled_since:null,daily_limit:1}],mood_enabled:false,evolution_enabled:false,daily_limit:3,cooldown_seconds:7200};
function boot(){
 state.command.mockImplementation((name:string)=>Promise.resolve(name==="soul_desktop_status"?{enabled:false,capture_permission:true,model:"test",checks_remaining:12,last_error:null}:name==="soul_get_desktop_settings"?{revision:1,frequency:"natural",excluded_apps:[]}:name==="soul_get_continuity"?{revision:1,history_enabled:false,days:0,nickname:null,nickname_options:[],milestones:[],proposals:[],versions:[]}:name==="soul_get_settings"||name==="soul_update_settings"?settings:role));
 return render(<SoulSettings />);
}
afterEach(()=>{cleanup();vi.restoreAllMocks();state.command.mockReset();state.toast.error.mockReset();state.toast.success.mockReset();});
it("sends role writes through the native input argument with the selected locale",async()=>{
 boot();
 fireEvent.change(await screen.findByLabelText("soul.settings.tone"),{target:{value:"edited"}});
 fireEvent.click(screen.getByRole("button",{name:"soul.settings.save"}));
 await waitFor(()=>expect(state.command).toHaveBeenCalledWith("soul_update_profile",{input:{expected_revision:4,locale:"ja-JP",user_overrides:{tone:"edited"}}}));
});
it("updates only the selected available category and uses CAS",async()=>{
 boot();
 fireEvent.click(await screen.findByLabelText("soul.category.greeting"));
 await waitFor(()=>expect(state.command).toHaveBeenCalledWith("soul_update_settings",{input:expect.objectContaining({expected_revision:7,categories:[expect.objectContaining({category:"greeting",enabled:true})]})}));
 expect(screen.getByRole("checkbox",{name:/soul.category.pattern/})).toHaveProperty("disabled",true);
});
it("confirms destructive actions and wraps reset and clearing inputs",async()=>{
 vi.spyOn(window,"confirm").mockReturnValue(true);
 boot();
 fireEvent.click(await screen.findByRole("button",{name:"soul.settings.reset"}));
 await waitFor(()=>expect(state.command).toHaveBeenCalledWith("soul_reset_profile",{input:{expected_revision:4,locale:"ja-JP",clear_evolution_history:false}}));
 fireEvent.click(screen.getByRole("button",{name:"soul.settings.clear"}));
 await waitFor(()=>expect(state.command).toHaveBeenCalledWith("soul_clear",{input:{scopes:["all"]}}));
});

it("updates the independent mood switch through the revision boundary",async()=>{
  boot();
  fireEvent.click(await screen.findByLabelText("soul.settings.mood"));
  await waitFor(()=>expect(state.command).toHaveBeenCalledWith("soul_update_settings",{input:expect.objectContaining({expected_revision:7,mood_enabled:true,enabled:null,categories:null})}));
});

it("category cleanup carries CAS and does not toggle switches",async()=>{
 vi.spyOn(window,"confirm").mockReturnValue(true);boot();
 fireEvent.click(await screen.findByRole("button",{name:"soul.settings.clearCategory soul.category.greeting"}));
 await waitFor(()=>expect(state.command).toHaveBeenCalledWith("soul_clear_category",{category:"greeting",expectedRevision:7}));
});
