//! Focus tools share the desktop timer and normal action confirmation gate.
use super::{PikoPlugin, PluginManifest, PluginToolManifest};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
pub(crate) struct FocusPlugin;
impl PikoPlugin for FocusPlugin {
    fn manifest(&self) -> PluginManifest {
        let read = PluginToolManifest {
            name: "get_focus_state".into(),
            description: "查询当前专注或休息计时、暂停状态及今日专注分钟数".into(),
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
            risk: "read".into(),
            confirmation: "never".into(),
        };
        let mut tools = vec![read];
        for (name, description, minutes) in [
            (
                "start_focus",
                "开始一段专注；如已有运行或暂停的计时会拒绝覆盖，先查询状态并询问用户如何处理",
                vec![15, 25, 45, 60],
            ),
            ("start_break", "开始休息；不会覆盖已有计时", vec![5, 10, 15]),
            ("pause_focus", "暂停当前专注或休息计时", vec![]),
            ("resume_focus", "继续已暂停的专注或休息计时", vec![]),
            ("stop_focus", "结束当前专注或休息计时，不计作完成", vec![]),
        ] {
            let schema = if minutes.is_empty() {
                json!({"type":"object","properties":{},"additionalProperties":false})
            } else {
                json!({"type":"object","properties":{"minutes":{"type":"integer","enum":minutes}},"required":["minutes"],"additionalProperties":false})
            };
            tools.push(PluginToolManifest {
                name: name.into(),
                description: description.into(),
                input_schema: schema,
                risk: "write".into(),
                confirmation: "always".into(),
            });
        }
        PluginManifest {
            id: "piko.focus".into(),
            name: "专注与休息".into(),
            version: "1.0.0".into(),
            description: "查询、开始、暂停、继续和结束桌面专注计时".into(),
            tools,
        }
    }
    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        let state = app.state::<crate::rhythm::FocusTimer>();
        let snapshot = match tool {
            "get_focus_state" => crate::rhythm::get_focus_state(app.clone(), state),
            "start_focus" | "start_break" => {
                let minutes = input["minutes"].as_u64().ok_or("请提供有效的分钟数")?;
                crate::rhythm::start_device_timer(
                    app.clone(),
                    state,
                    if tool == "start_focus" {
                        "focus"
                    } else {
                        "break"
                    },
                    minutes,
                )
            }
            "pause_focus" => crate::rhythm::pause_focus(app.clone(), state),
            "resume_focus" => crate::rhythm::resume_focus(app.clone(), state),
            "stop_focus" => crate::rhythm::stop_focus(app.clone(), state),
            _ => return Err("不支持的专注工具".into()),
        }?;
        serde_json::to_value(snapshot).map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writes_require_confirmation_and_durations_are_bounded() {
        let manifest = FocusPlugin.manifest();
        assert_eq!(manifest.tools.len(), 6);
        assert_eq!(manifest.tools[0].confirmation, "never");
        assert!(manifest.tools[1..]
            .iter()
            .all(|t| t.confirmation == "always" && t.risk == "write"));
        assert_eq!(
            manifest.tools[1].input_schema["properties"]["minutes"]["enum"],
            json!([15, 25, 45, 60])
        );
        assert_eq!(
            manifest.tools[2].input_schema["properties"]["minutes"]["enum"],
            json!([5, 10, 15])
        );
    }
}
