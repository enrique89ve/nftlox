import {
	createPayload,
	type ProtocolAction,
	type PayloadDataByAction,
	type TypedProtocolPayload,
} from "@nftlox/protocol";
import { getProtocolId, getProtocolVersion } from "./protocol-state";

/** Build a payload using the protocol version and id last accepted by the SDK. */
export function createSdkPayload<A extends ProtocolAction>(
	action: A,
	data: PayloadDataByAction[A],
): TypedProtocolPayload<A> {
	return createPayload(action, data, {
		protocol: getProtocolId(),
		version: getProtocolVersion(),
	});
}
