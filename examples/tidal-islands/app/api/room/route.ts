import { env } from "cloudflare:workers";
import { assertRoomRequestOrigin, createD1RoomStore, createRoomService, RoomError, roomRequestToken } from "../../../lib/room-service";

const responseHeaders = { "Cache-Control": "no-store, private", "Vary": "Authorization", "X-Content-Type-Options": "nosniff" };

function service() {
  if (!env.DB) throw new RoomError("联机数据库尚未启用，请先配置房间存储。", 503, "DATABASE_UNAVAILABLE");
  return createRoomService(createD1RoomStore(env.DB));
}

function failure(error: unknown) {
  if (error instanceof RoomError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: responseHeaders });
  return Response.json({ error: "房间服务暂时不可用，请稍后重试。", code: "SERVER_ERROR" }, { status: 500, headers: responseHeaders });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const result = await service().get(url.searchParams.get("code"), roomRequestToken(request, url.searchParams.get("token")));
    return Response.json(result, { headers: responseHeaders });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertRoomRequestOrigin(request);
    if (Number(request.headers.get("Content-Length") ?? 0) > 32768) throw new RoomError("请求内容过大。", 413);
    const text = await request.text();
    if (text.length > 32768) throw new RoomError("请求内容过大。", 413);
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed;
    } catch {
      throw new RoomError("请求内容必须是有效的 JSON 对象。");
    }
    payload.token = roomRequestToken(request, payload.token);
    const rooms = service();
    const type = payload.type;
    if (type !== "create" && type !== "join" && type !== "start" && type !== "action" && type !== "updateOptions") throw new RoomError("未知的房间操作。");
    const result = await rooms[type](payload);
    return Response.json(result, { status: type === "create" ? 201 : 200, headers: responseHeaders });
  } catch (error) {
    return failure(error);
  }
}
