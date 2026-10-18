// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {ContinuitySettings} from "./ContinuitySettings";
const mock=vi.hoisted(()=>({command:vi.fn(),toast:{error:vi.fn()},t:(key:string)=>key}));
vi.mock("../app/appRuntime",()=>({runCommand:mock.command}));
vi.mock("../i18n/I18nProvider",()=>({useTranslation:()=>({t:mock.t,locale:"en-US"})}));
vi.mock("../../components/feedback/toastStore",()=>({useToast:()=>mock.toast}));
const data={revision:2,history_enabled:true,days:3,nickname:null,nickname_options:["partner"],milestones:["first_task"],proposals:[{id:"proposal",field:"tone",before:null,after:"concise",evidence_count:3}],versions:[{id:"role-1",revision:1,snapshot:"{}",created_at:100}]};
function boot(){mock.command.mockImplementation((name:string)=>Promise.resolve(name==="soul_get_continuity"?data:undefined));return render(<ContinuitySettings roleRevision={4} onChanged={()=>undefined}/>);}
afterEach(()=>{cleanup();vi.restoreAllMocks();mock.command.mockReset();mock.toast.error.mockReset();});
it("does not automatically select an unlocked name and sends explicit choices with CAS",async()=>{
 boot();const select=await screen.findByLabelText("soul.continuity.nickname");expect(select).toHaveProperty("value","");
 expect(screen.queryByRole("option",{name:"soul.continuity.names.friend"})).toBeNull();
 fireEvent.change(select,{target:{value:"partner"}});
 await waitFor(()=>expect(mock.command).toHaveBeenCalledWith("soul_update_continuity",{expectedRevision:2,historyEnabled:true,nickname:"partner"}));
});
it("approval carries the visible role revision and rollback requires the user's confirmation",async()=>{
 vi.spyOn(window,"confirm").mockReturnValue(false);boot();
 fireEvent.click(await screen.findByRole("button",{name:"soul.review.approve"}));
 await waitFor(()=>expect(mock.command).toHaveBeenCalledWith("soul_review_evolution",{id:"proposal",approve:true,expectedRevision:4,locale:"en-US"}));
 fireEvent.click(screen.getByRole("button",{name:"soul.continuity.rollback"}));expect(mock.command).not.toHaveBeenCalledWith("soul_rollback_evolution",expect.anything());
 vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByRole("button",{name:"soul.continuity.rollback"}));
 await waitFor(()=>expect(mock.command).toHaveBeenCalledWith("soul_rollback_evolution",{id:"role-1",expectedRevision:4}));
});
