//! Opt-in LAN bridge for one Passport. No model credentials cross this boundary.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::{Message, WebSocket};

const PORT: u16 = 19388;
const DISCOVERY_PORT: u16 = 19389;
const DISCOVERY_TTL: Duration = Duration::from_secs(30);
const PAIR_TTL: Duration = Duration::from_secs(300);
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedDevice {
    id: String,
    name: String,
    token_hash: String,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceStatus {
    running: bool,
    port: u16,
    pairing_code: Option<String>,
    pairing_seconds: u64,
    device_id: Option<String>,
    device_name: Option<String>,
    connected: bool,
    battery: Option<u8>,
    firmware: Option<String>,
    error: Option<String>,
    pending_device: Option<String>,
    pending_request: Option<String>,
}
struct DiscoveryRequest {
    id: String,
    nonce: String,
    seen: Instant,
}
#[derive(Default)]
struct Inner {
    running: bool,
    generation: u64,
    pairing: Option<(String, Instant)>,
    pending: Option<DiscoveryRequest>,
    approved: Option<(String, String)>,
    paired: Option<PairedDevice>,
    connected: bool,
    battery: Option<u8>,
    firmware: Option<String>,
    pet: Option<Value>,
    error: Option<String>,
    seen: VecDeque<String>,
}
#[derive(Default)]
pub(crate) struct DeviceBridge(Arc<Mutex<Inner>>);
fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("passport-device.json"))
}
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut data = vec![0; bytes];
    getrandom::fill(&mut data).map_err(|e| e.to_string())?;
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}
fn hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
fn status(inner: &Inner) -> DeviceStatus {
    let remaining = inner
        .pairing
        .as_ref()
        .map(|(_, at)| PAIR_TTL.saturating_sub(at.elapsed()).as_secs())
        .unwrap_or(0);
    DeviceStatus {
        running: inner.running,
        port: PORT,
        pairing_code: if remaining > 0 {
            inner.pairing.as_ref().map(|(c, _)| c.clone())
        } else {
            None
        },
        pairing_seconds: remaining,
        device_id: inner.paired.as_ref().map(|d| d.id.clone()),
        device_name: inner.paired.as_ref().map(|d| d.name.clone()),
        connected: inner.connected,
        battery: inner.battery,
        firmware: inner.firmware.clone(),
        error: inner.error.clone(),
        pending_device: inner
            .pending
            .as_ref()
            .filter(|p| p.seen.elapsed() < DISCOVERY_TTL)
            .map(|p| p.id.clone()),
        pending_request: inner
            .pending
            .as_ref()
            .filter(|p| p.seen.elapsed() < DISCOVERY_TTL)
            .map(|p| p.nonce.clone()),
    }
}
#[derive(Default, Serialize, Deserialize)]
struct BridgePreference {
    enabled: bool,
}

fn preference_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(path(app)?.with_file_name("passport-bridge.json"))
}

pub(crate) fn restore_device_bridge(app: &AppHandle) {
    let result = (|| -> Result<(), String> {
        let preference: BridgePreference = crate::storage::read(&preference_path(app)?)?;
        if preference.enabled {
            start_device_bridge(app.clone(), app.state::<DeviceBridge>())?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(mut inner) = app.state::<DeviceBridge>().0.lock() {
            inner.error = Some(error);
        }
    }
}

#[tauri::command]
pub(crate) fn get_device_status(bridge: State<'_, DeviceBridge>) -> DeviceStatus {
    status(&bridge.0.lock().unwrap())
}
#[tauri::command]
pub(crate) fn start_device_bridge(
    app: AppHandle,
    bridge: State<'_, DeviceBridge>,
) -> Result<DeviceStatus, String> {
    let mut inner = bridge.0.lock().map_err(|e| e.to_string())?;
    if inner.running {
        return Ok(status(&inner));
    }
    let paired: PairedDevice = crate::storage::read(&path(&app)?)?;
    let listener = TcpListener::bind(("0.0.0.0", PORT))
        .map_err(|e| format!("无法监听设备端口 {PORT}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let discovery = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT))
        .map_err(|e| format!("无法监听设备发现端口 {DISCOVERY_PORT}: {e}"))?;
    discovery
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;
    crate::storage::write(&preference_path(&app)?, &BridgePreference { enabled: true })?;
    inner.paired = if paired.id.is_empty() {
        None
    } else {
        Some(paired)
    };
    inner.running = true;
    inner.generation += 1;
    inner.error = None;
    let generation = inner.generation;
    let shared = bridge.0.clone();
    let discovery_shared = shared.clone();
    std::thread::spawn(move || discover(discovery, discovery_shared, generation));
    std::thread::spawn(move || serve(app, listener, shared, generation));
    Ok(status(&inner))
}
#[tauri::command]
pub(crate) fn stop_device_bridge(app: AppHandle, bridge: State<'_, DeviceBridge>) -> DeviceStatus {
    let mut inner = bridge.0.lock().unwrap();
    let saved = preference_path(&app)
        .and_then(|path| crate::storage::write(&path, &BridgePreference { enabled: false }));
    inner.error = saved.err();
    inner.running = false;
    inner.connected = false;
    inner.pairing = None;
    inner.pending = None;
    inner.approved = None;
    inner.generation += 1;
    status(&inner)
}
#[tauri::command]
pub(crate) fn begin_device_pairing(
    bridge: State<'_, DeviceBridge>,
    request_id: Option<String>,
) -> Result<DeviceStatus, String> {
    let mut inner = bridge.0.lock().map_err(|e| e.to_string())?;
    if !inner.running {
        return Err("请先开启设备连接".into());
    }
    if inner.paired.is_some() {
        return Err("请先解除现有设备配对".into());
    }
    inner.approved = if let Some(request_id) = request_id {
        let pending = inner
            .pending
            .as_ref()
            .filter(|p| p.seen.elapsed() < DISCOVERY_TTL && p.nonce == request_id)
            .ok_or("设备请求已变化或过期，请重新确认")?;
        Some((pending.id.clone(), pending.nonce.clone()))
    } else {
        None
    };
    inner.pairing = Some((random_hex(4)?, Instant::now()));
    Ok(status(&inner))
}
#[tauri::command]
pub(crate) fn forget_device(
    app: AppHandle,
    bridge: State<'_, DeviceBridge>,
) -> Result<DeviceStatus, String> {
    let mut inner = bridge.0.lock().map_err(|e| e.to_string())?;
    crate::storage::write(&path(&app)?, &PairedDevice::default())?;
    inner.paired = None;
    inner.connected = false;
    inner.battery = None;
    inner.firmware = None;
    inner.seen.clear();
    inner.pairing = None;
    inner.pending = None;
    inner.approved = None;
    Ok(status(&inner))
}
#[tauri::command]
pub(crate) fn publish_device_pet(
    bridge: State<'_, DeviceBridge>,
    mode: String,
    emotion: String,
    reaction: String,
) -> Result<(), String> {
    if mode.len() > 32 || emotion.len() > 32 || reaction.len() > 32 {
        return Err("宠物状态过长".into());
    }
    bridge.0.lock().map_err(|e| e.to_string())?.pet =
        Some(json!({"mode":mode,"emotion":emotion,"reaction":reaction}));
    Ok(())
}
fn active(shared: &Mutex<Inner>, generation: u64) -> bool {
    let i = shared.lock().unwrap();
    i.running && i.generation == generation
}
// Discovery carries no model credentials or persistent device token. A new
// device receives a short-lived pairing code only after explicit desktop approval.
fn discovery_reply(i: &mut Inner, request: &Value) -> Option<Value> {
    if !i.running || request["v"] != 1 || request["type"] != "piko-discover" {
        return None;
    }
    let id = request["deviceId"].as_str().filter(|id| valid_id(id))?;
    let nonce = request["nonce"]
        .as_str()
        .filter(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let mut reply = json!({"v":1,"type":"piko-service","nonce":nonce,"port":PORT});
    if let Some(paired) = &i.paired {
        return (paired.id == id).then_some(reply);
    }
    if i.pairing
        .as_ref()
        .is_some_and(|(_, at)| at.elapsed() >= PAIR_TTL)
    {
        i.pairing = None;
        i.approved = None;
    }
    let approved = i
        .approved
        .as_ref()
        .is_some_and(|(a, b)| a == id && b == nonce);
    if approved {
        if let Some(p) = i.pending.as_mut() {
            p.seen = Instant::now();
        }
        let (code, at) = i.pairing.as_ref()?;
        if at.elapsed() >= PAIR_TTL {
            return None;
        }
        reply["pairingCode"] = json!(code);
        return Some(reply);
    }
    // A physical connect action on the Passport replaces desktop confirmation.
    // Bind the short-lived credential to this exact device and discovery nonce.
    if request["pairRequested"] == true && i.approved.as_ref().is_none_or(|(a, _)| a == id) {
        i.approved = Some((id.into(), nonce.into()));
        i.pairing = Some((random_hex(4).ok()?, Instant::now()));
        i.pending = Some(DiscoveryRequest {
            id: id.into(),
            nonce: nonce.into(),
            seen: Instant::now(),
        });
        return discovery_reply(i, request);
    }
    // Keep a live request stable while the user reviews it; another device
    // cannot silently replace the identity underneath the confirmation button.
    if i.pending
        .as_ref()
        .is_none_or(|p| p.seen.elapsed() >= DISCOVERY_TTL || (p.id == id && p.nonce == nonce))
    {
        i.pending = Some(DiscoveryRequest {
            id: id.into(),
            nonce: nonce.into(),
            seen: Instant::now(),
        });
    }
    None
}
fn discover(socket: UdpSocket, shared: Arc<Mutex<Inner>>, generation: u64) {
    let mut buf = [0u8; 512];
    while active(&shared, generation) {
        let Ok((len, peer)) = socket.recv_from(&mut buf) else {
            continue;
        };
        if !peer.ip().is_ipv4() || peer.port() == 0 {
            continue;
        }
        let Ok(request) = serde_json::from_slice::<Value>(&buf[..len]) else {
            continue;
        };
        let reply = {
            let mut i = shared.lock().unwrap();
            if !i.running || i.generation != generation {
                break;
            }
            discovery_reply(&mut i, &request)
        };
        if let Some(reply) = reply {
            let _ = socket.send_to(reply.to_string().as_bytes(), peer);
        }
    }
}

fn serve(app: AppHandle, listener: TcpListener, shared: Arc<Mutex<Inner>>, generation: u64) {
    while active(&shared, generation) {
        match listener.accept() {
            Ok((stream, _)) => {
                let result = session(&app, stream, &shared, generation);
                let mut i = shared.lock().unwrap();
                if i.generation == generation {
                    i.connected = false;
                    if let Err(e) = result {
                        i.error = Some(e);
                    }
                }
                // Bound authentication attempts, including malformed requests.
                drop(i);
                std::thread::sleep(Duration::from_millis(300));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(_) => break,
        }
    }
}
fn send(ws: &mut WebSocket<TcpStream>, value: Value) -> Result<(), String> {
    ws.send(Message::Text(value.to_string().into()))
        .map_err(|e| e.to_string())
}
enum Packet {
    Json(Value),
    Audio(Vec<u8>),
}
fn read_packet(ws: &mut WebSocket<TcpStream>) -> Result<Option<Packet>, String> {
    match ws.read() {
        Ok(Message::Text(t)) => serde_json::from_str(&t)
            .map(|v| Some(Packet::Json(v)))
            .map_err(|_| "设备消息格式错误".into()),
        Ok(Message::Binary(data)) => Ok(Some(Packet::Audio(data.to_vec()))),
        Ok(Message::Close(_)) => Err("设备已断开".into()),
        Ok(_) => Ok(None),
        Err(tungstenite::Error::Io(e))
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(e.to_string()),
    }
}
fn read_json(ws: &mut WebSocket<TcpStream>) -> Result<Option<Value>, String> {
    match read_packet(ws)? {
        Some(Packet::Json(v)) => Ok(Some(v)),
        Some(Packet::Audio(_)) => Err("认证前不接受音频".into()),
        None => Ok(None),
    }
}
fn wait_for_hello(ws: &mut WebSocket<TcpStream>, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        // Ping/Pong and a short socket timeout are not missing credentials.
        if let Some(hello) = read_json(ws)? {
            return Ok(hello);
        }
    }
    Err("等待设备认证超时，请重试连接".into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn validate_hello(i: &Inner, hello: &Value) -> Result<String, String> {
    let id = hello["deviceId"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("设备 ID 无效")?;
    if hello["v"] != 1 || hello["type"] != "hello" {
        return Err("设备协议版本不支持".into());
    }
    if let Some(paired) = &i.paired {
        let supplied = hello["token"].as_str().unwrap_or("");
        if supplied.len() != 64 || paired.id != id || paired.token_hash != hash(supplied) {
            return Err("设备认证失败".into());
        }
    } else {
        if i.approved
            .as_ref()
            .is_some_and(|(a, b)| a != id || hello["discoveryNonce"].as_str() != Some(b.as_str()))
        {
            return Err("设备与已确认的配对请求不一致".into());
        }
        let valid = i.pairing.as_ref().is_some_and(|(code, at)| {
            at.elapsed() < PAIR_TTL && hello["pairingCode"].as_str() == Some(code.as_str())
        });
        if !valid {
            return Err("配对码错误或已过期".into());
        }
    }
    Ok(id.to_owned())
}
fn session(
    app: &AppHandle,
    stream: TcpStream,
    shared: &Mutex<Inner>,
    generation: u64,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(4096))
        .max_frame_size(Some(4096));
    let mut ws =
        tungstenite::accept_with_config(stream, Some(config)).map_err(|e| e.to_string())?;
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;
    let hello = wait_for_hello(&mut ws, Duration::from_secs(10))?;
    let id;
    let token;
    {
        let mut i = shared.lock().unwrap();
        if !i.running || i.generation != generation {
            return Err("设备连接已关闭".into());
        }
        if i.paired.is_none()
            && hello["v"] == 1
            && hello["type"] == "hello"
            && hello["disconnectRequested"] == true
        {
            send(&mut ws, json!({"v":1,"type":"unpaired"}))?;
            return Ok(());
        }
        id = validate_hello(&i, &hello)?;
        if i.paired.is_some() {
            token = None;
        } else {
            let secret = random_hex(32)?;
            let paired = PairedDevice {
                id: id.clone(),
                name: "Piko Passport".into(),
                token_hash: hash(&secret),
            };
            crate::storage::write(&path(app)?, &paired)?;
            i.paired = Some(paired);
            i.pairing = None;
            i.pending = None;
            i.approved = None;
            i.seen.clear();
            token = Some(secret);
        }
        i.connected = true;
        i.error = None;
    }
    send(
        &mut ws,
        json!({"v":1,"type":"welcome","token":token,"capabilities":["voice-long-upload-v1"]}),
    )?;
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|e| e.to_string())?;
    let mut last_snapshot = Instant::now() - Duration::from_secs(2);
    let mut last_rx = Instant::now();
    let supports_confirmation = hello["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|value| value == "voice-confirm-v1"));
    let supports_streaming = hello["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|v| v == "voice-stream-v1"));
    let mut voice = crate::device_voice::Channel::new(supports_confirmation, supports_streaming);
    while active(shared, generation) {
        if shared
            .lock()
            .unwrap()
            .paired
            .as_ref()
            .is_none_or(|p| p.id != id)
        {
            break;
        }
        if last_snapshot.elapsed() >= Duration::from_secs(1) {
            let focus =
                crate::rhythm::focus_snapshot(app, &app.state::<crate::rhythm::FocusTimer>())?;
            let pet = shared
                .lock()
                .unwrap()
                .pet
                .clone()
                .unwrap_or(json!({"mode":"idle","emotion":"neutral","reaction":"none"}));
            send(
                &mut ws,
                json!({"v":1,"type":"state","petName":crate::settings::read_settings(app).companion_name,"pet":pet,"focus":focus}),
            )?;
            last_snapshot = Instant::now();
        }
        if last_rx.elapsed() > Duration::from_secs(30) {
            return Err("设备心跳超时".into());
        }
        voice.poll(&mut ws)?;
        let msg = match read_packet(&mut ws)? {
            Some(Packet::Json(msg)) => msg,
            Some(Packet::Audio(data)) => {
                last_rx = Instant::now();
                voice.binary(&mut ws, &data)?;
                continue;
            }
            None => continue,
        };
        last_rx = Instant::now();
        if msg["v"] != 1 {
            return Err("设备协议版本不支持".into());
        }
        if msg["type"] == "unpair" {
            let mut i = shared.lock().unwrap();
            // This packet is accepted only on the authenticated device session.
            crate::storage::write(&path(app)?, &PairedDevice::default())?;
            i.paired = None;
            i.connected = false;
            i.pairing = None;
            i.pending = None;
            i.approved = None;
            i.battery = None;
            i.firmware = None;
            i.seen.clear();
            i.error = None;
            drop(i);
            send(&mut ws, json!({"v":1,"type":"unpaired"}))?;
            break;
        }
        if voice.json(app, &id, &mut ws, &msg)? {
            continue;
        }
        if msg["type"] == "heartbeat" {
            let mut i = shared.lock().unwrap();
            i.battery = msg["battery"]
                .as_u64()
                .filter(|n| *n <= 100)
                .map(|n| n as u8);
            i.firmware = msg["firmware"]
                .as_str()
                .map(|s| s.chars().take(40).collect());
        } else if msg["type"] == "event" {
            let event_id = msg["id"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("事件 ID 无效")?
                .to_owned();
            let action = msg["action"].as_str().unwrap_or("");
            let result = apply_event(shared, &event_id, || dispatch(app, action));
            send(
                &mut ws,
                json!({"v":1,"type":"ack","id":event_id,"ok":result.is_ok(),"error":result.err()}),
            )?;
            last_snapshot = Instant::now() - Duration::from_secs(2);
        }
    }
    let _ = ws.close(None);
    Ok(())
}
// Only the single authenticated session dispatches actions. Keep failed events retryable.
fn apply_event(
    shared: &Mutex<Inner>,
    id: &str,
    dispatch: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if shared.lock().unwrap().seen.iter().any(|seen| seen == id) {
        return Ok(());
    }
    dispatch()?;
    let mut i = shared.lock().unwrap();
    if i.seen.len() >= 128 {
        i.seen.pop_front();
    }
    i.seen.push_back(id.to_owned());
    Ok(())
}
fn dispatch(app: &AppHandle, action: &str) -> Result<(), String> {
    let focus = app.state::<crate::rhythm::FocusTimer>();
    match action {
        "interact" => app
            .emit_to("pet", "passport-interact", ())
            .map_err(|e| e.to_string()),
        "focus_start" => crate::rhythm::start_focus_from_device(app.clone(), focus).map(|_| ()),
        "focus_pause" => crate::rhythm::pause_focus(app.clone(), focus).map(|_| ()),
        "focus_resume" => crate::rhythm::resume_focus(app.clone(), focus).map(|_| ()),
        "focus_stop" => crate::rhythm::stop_focus(app.clone(), focus).map(|_| ()),
        _ => Err("不支持的设备操作".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_connect_pairs_once_and_binds_identity_and_nonce() {
        let mut i = Inner {
            running: true,
            ..Default::default()
        };
        let req = json!({"v":1,"type":"piko-discover","deviceId":"passport-one","nonce":"a".repeat(32),"pairRequested":true});
        let reply = discovery_reply(&mut i, &req).unwrap();
        let code = reply["pairingCode"].as_str().unwrap();
        assert_eq!(code.len(), 8);
        let hello = json!({"v":1,"type":"hello","deviceId":"passport-one","discoveryNonce":"a".repeat(32),"pairingCode":code});
        assert!(validate_hello(&i, &hello).is_ok());
        let mut other = req.clone();
        other["deviceId"] = json!("passport-two");
        assert!(discovery_reply(&mut i, &other).is_none());
        let mut stale = hello.clone();
        stale["discoveryNonce"] = json!("b".repeat(32));
        assert!(validate_hello(&i, &stale).is_err());
        i.pairing.as_mut().unwrap().1 = Instant::now() - PAIR_TTL;
        assert!(discovery_reply(&mut i, &other).is_some());
        assert!(validate_hello(&i, &hello).is_err());
    }

    #[test]
    fn disconnect_intent_does_not_bypass_existing_token_authentication() {
        let token = "a".repeat(64);
        let i = Inner {
            paired: Some(PairedDevice {
                id: "passport-one".into(),
                token_hash: hash(&token),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut hello =
            json!({"v":1,"type":"hello","deviceId":"passport-one","disconnectRequested":true});
        assert!(validate_hello(&i, &hello).is_err());
        hello["token"] = json!(token);
        assert!(validate_hello(&i, &hello).is_ok());
    }

    #[test]
    fn authentication_waits_through_control_frames_and_short_read_timeouts() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            ws.get_mut()
                .set_read_timeout(Some(Duration::from_millis(20)))
                .unwrap();
            let hello = wait_for_hello(&mut ws, Duration::from_secs(2)).unwrap();
            assert_eq!(hello["type"], "hello");
            send(&mut ws, json!({"type":"welcome"})).unwrap();
        });
        let stream = TcpStream::connect(address).unwrap();
        let (mut client, _) = tungstenite::client(format!("ws://{address}"), stream).unwrap();
        client.send(Message::Ping(vec![1, 2].into())).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        send(&mut client, json!({"type":"hello"})).unwrap();
        loop {
            if let Some(value) = read_json(&mut client).unwrap() {
                assert_eq!(value["type"], "welcome");
                break;
            }
        }
        thread.join().unwrap();
    }
    #[test]
    fn silent_device_authentication_has_a_bounded_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            ws.get_mut()
                .set_read_timeout(Some(Duration::from_millis(20)))
                .unwrap();
            assert!(wait_for_hello(&mut ws, Duration::from_millis(100))
                .unwrap_err()
                .contains("认证超时"));
        });
        let stream = TcpStream::connect(address).unwrap();
        let (_client, _) = tungstenite::client(format!("ws://{address}"), stream).unwrap();
        thread.join().unwrap();
    }
    #[test]
    fn discovery_requires_explicit_approval_and_binds_nonce_and_id() {
        let mut i = Inner {
            running: true,
            ..Default::default()
        };
        let nonce = "a".repeat(32);
        let req = json!({"v":1,"type":"piko-discover","deviceId":"passport-one","nonce":nonce});
        assert!(discovery_reply(&mut i, &req).is_none());
        assert_eq!(status(&i).pending_device.as_deref(), Some("passport-one"));
        let other =
            json!({"v":1,"type":"piko-discover","deviceId":"passport-two","nonce":"b".repeat(32)});
        assert!(discovery_reply(&mut i, &other).is_none());
        assert_eq!(status(&i).pending_device.as_deref(), Some("passport-one"));
        i.approved = Some(("passport-one".into(), nonce.clone()));
        i.pairing = Some(("1234abcd".into(), Instant::now()));
        let response = discovery_reply(&mut i, &req).unwrap();
        assert_eq!(response["pairingCode"], "1234abcd");
        assert!(discovery_reply(&mut i, &other).is_none());
        let mut hello = json!({"v":1,"type":"hello","deviceId":"passport-one","pairingCode":"1234abcd","discoveryNonce":nonce});
        assert!(validate_hello(&i, &hello).is_ok());
        hello["discoveryNonce"] = json!("b".repeat(32));
        assert!(validate_hello(&i, &hello).is_err());
        i.pairing = Some(("1234abcd".into(), Instant::now() - PAIR_TTL));
        assert!(discovery_reply(&mut i, &req).is_none());
        i.paired = Some(PairedDevice {
            id: "passport-one".into(),
            ..Default::default()
        });
        let response = discovery_reply(&mut i, &req).unwrap();
        assert!(response.get("pairingCode").is_none());
        assert!(discovery_reply(&mut i, &other).is_none());
        i.running = false;
        assert!(discovery_reply(&mut i, &req).is_none());
    }
    #[test]
    fn discovery_rejects_invalid_requests_and_hides_stale_pending() {
        let mut i = Inner {
            running: true,
            ..Default::default()
        };
        for req in [
            json!({}),
            json!({"v":2,"type":"piko-discover","deviceId":"passport-one","nonce":"a".repeat(32)}),
            json!({"v":1,"type":"piko-discover","deviceId":"../bad","nonce":"a".repeat(32)}),
            json!({"v":1,"type":"piko-discover","deviceId":"passport-one","nonce":"short"}),
        ] {
            assert!(discovery_reply(&mut i, &req).is_none());
            assert!(i.pending.is_none());
        }
        i.pending = Some(DiscoveryRequest {
            id: "old".into(),
            nonce: "a".repeat(32),
            seen: Instant::now() - DISCOVERY_TTL,
        });
        assert!(status(&i).pending_request.is_none());
    }
    #[test]
    fn pairing_expires_and_does_not_expose_token() {
        let mut i = Inner {
            pairing: Some(("abcd1234".into(), Instant::now() - PAIR_TTL)),
            ..Default::default()
        };
        assert!(status(&i).pairing_code.is_none());
        i.paired = Some(PairedDevice {
            id: "device-1".into(),
            name: "Passport".into(),
            token_hash: hash("secret"),
        });
        assert!(!serde_json::to_string(&status(&i))
            .unwrap()
            .contains(&hash("secret")));
    }
    #[test]
    fn auth_requires_current_pairing_or_device_bound_secret() {
        let hello =
            json!({"v":1,"type":"hello","deviceId":"passport-123","pairingCode":"1234abcd"});
        let mut i = Inner::default();
        assert!(validate_hello(&i, &hello).is_err());
        i.pairing = Some(("1234abcd".into(), Instant::now()));
        assert_eq!(validate_hello(&i, &hello).unwrap(), "passport-123");
        i.pairing = Some(("1234abcd".into(), Instant::now() - PAIR_TTL));
        assert!(validate_hello(&i, &hello).is_err());
        let token = "a".repeat(64);
        i.paired = Some(PairedDevice {
            id: "passport-123".into(),
            name: "Passport".into(),
            token_hash: hash(&token),
        });
        assert!(validate_hello(&i, &hello).is_err());
        let mut hello = json!({"v":1,"type":"hello","deviceId":"passport-123","token":token});
        assert!(validate_hello(&i, &hello).is_ok());
        hello["deviceId"] = json!("passport-other");
        assert!(validate_hello(&i, &hello).is_err());
        hello["deviceId"] = json!("passport-123");
        hello["v"] = json!(2);
        assert!(validate_hello(&i, &hello).is_err());
    }
    #[test]
    fn wire_round_trip_and_oversized_frame_rejection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let config = tungstenite::protocol::WebSocketConfig::default()
                .max_message_size(Some(4096))
                .max_frame_size(Some(4096));
            let mut ws = tungstenite::accept_with_config(stream, Some(config)).unwrap();
            assert_eq!(read_json(&mut ws).unwrap().unwrap()["type"], "hello");
            send(&mut ws, json!({"v":1,"type":"welcome"})).unwrap();
            assert!(read_json(&mut ws).is_err());
        });
        let stream = TcpStream::connect(address).unwrap();
        let (mut client, _) = tungstenite::client(format!("ws://{address}"), stream).unwrap();
        client
            .send(Message::Text(
                json!({"v":1,"type":"hello"}).to_string().into(),
            ))
            .unwrap();
        assert_eq!(read_json(&mut client).unwrap().unwrap()["type"], "welcome");
        let _ = client.send(Message::Text("x".repeat(5000).into()));
        thread.join().unwrap();
    }
    #[test]
    fn retransmits_apply_once_and_failed_actions_can_retry() {
        let shared = Mutex::new(Inner::default());
        let count = std::cell::Cell::new(0);
        let apply = || {
            count.set(count.get() + 1);
            Ok(())
        };
        apply_event(&shared, "boot-1", apply).unwrap();
        apply_event(&shared, "boot-1", apply).unwrap();
        assert_eq!(count.get(), 1);
        assert!(apply_event(&shared, "boot-2", || Err("busy".into())).is_err());
        apply_event(&shared, "boot-2", apply).unwrap();
        assert_eq!(count.get(), 2);
        for n in 0..150 {
            apply_event(&shared, &format!("other-{n}"), || Ok(())).unwrap();
        }
        assert_eq!(shared.lock().unwrap().seen.len(), 128);
    }
    #[test]
    fn restrict_ids() {
        assert!(valid_id("passport-123_ab"));
        assert!(!valid_id("../device"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
    }
}
