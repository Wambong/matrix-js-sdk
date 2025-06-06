/*
Copyright 2022 - 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { type Mocked, mocked } from "jest-mock";
import fetchMock from "fetch-mock-jest";

import { logger } from "../../src/logger";
import {
    ClientEvent,
    type IMatrixClientCreateOpts,
    type ITurnServerResponse,
    MatrixClient,
    type Store,
} from "../../src/client";
import { Filter } from "../../src/filter";
import { DEFAULT_TREE_POWER_LEVELS_TEMPLATE } from "../../src/models/MSC3089TreeSpace";
import {
    EventType,
    MsgType,
    RelationType,
    RoomCreateTypeField,
    RoomType,
    UNSTABLE_MSC3088_ENABLED,
    UNSTABLE_MSC3088_PURPOSE,
    UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "../../src/@types/event";
import { EventStatus, MatrixEvent } from "../../src/models/event";
import { Preset } from "../../src/@types/partials";
import { ReceiptType } from "../../src/@types/read_receipts";
import * as testUtils from "../test-utils/test-utils";
import { makeBeaconInfoContent } from "../../src/content-helpers";
import { M_BEACON_INFO } from "../../src/@types/beacon";
import {
    ClientPrefix,
    ConditionKind,
    ContentHelpers,
    createClient,
    Direction,
    EventTimeline,
    EventTimelineSet,
    getHttpUriForMxc,
    type ICreateRoomOpts,
    type IPushRule,
    type IRequestOpts,
    MatrixError,
    type MatrixHttpApi,
    type MatrixScheduler,
    Method,
    PushRuleActionName,
    Room,
    RuleId,
    TweakName,
    UpdateDelayedEventAction,
} from "../../src";
import { supportsMatrixCall } from "../../src/webrtc/call";
import { makeBeaconEvent } from "../test-utils/beacon";
import {
    IGNORE_INVITES_ACCOUNT_EVENT_KEY,
    POLICIES_ACCOUNT_EVENT_TYPE,
    PolicyRecommendation,
    PolicyScope,
} from "../../src/models/invites-ignorer";
import { defer, type QueryDict } from "../../src/utils";
import { type SyncState } from "../../src/sync";
import * as featureUtils from "../../src/feature";
import { StubStore } from "../../src/store/stub";
import { type ServerSideSecretStorageImpl } from "../../src/secret-storage";
import { KnownMembership } from "../../src/@types/membership";
import { type RoomMessageEventContent } from "../../src/@types/events";
import { mockOpenIdConfiguration } from "../test-utils/oidc.ts";
import { type CryptoBackend } from "../../src/common-crypto/CryptoBackend";
import { SyncResponder } from "../test-utils/SyncResponder.ts";
import { mockInitialApiRequests } from "../test-utils/mockEndpoints.ts";

jest.useFakeTimers();

jest.mock("../../src/webrtc/call", () => ({
    ...jest.requireActual("../../src/webrtc/call"),
    supportsMatrixCall: jest.fn(() => false),
}));

// Utility function to ease the transition from our QueryDict type to a Map
// which we can use to build a URLSearchParams
function convertQueryDictToMap(queryDict?: QueryDict): Map<string, string> {
    if (!queryDict) {
        return new Map();
    }

    return new Map(Object.entries(queryDict).map(([k, v]) => [k, String(v)]));
}

declare module "../../src/@types/event" {
    interface AccountDataEvents {
        "im.vector.test": {};
    }
}

type HttpLookup = {
    method: string;
    path: string;
    prefix?: string;
    data?: Record<string, any> | Record<string, any>[];
    error?: object;
    expectBody?: Record<string, any>;
    expectQueryParams?: QueryDict;
    thenCall?: () => void;
};

interface Options extends ICreateRoomOpts {
    _roomId?: string;
}

type WrappedRoom = Room & {
    _options: Options;
    _state: Map<string, any>;
};

/** A list of methods to run after the current test */
const afterTestHooks: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    fetchMock.reset();
    jest.restoreAllMocks();
    for (const hook of afterTestHooks) {
        await hook();
    }
    afterTestHooks.length = 0;
});

describe("convertQueryDictToMap", () => {
    it("returns an empty map when dict is undefined", () => {
        expect(convertQueryDictToMap(undefined)).toEqual(new Map());
    });

    it("converts an empty QueryDict to an empty map", () => {
        expect(convertQueryDictToMap({})).toEqual(new Map());
    });

    it("converts a QueryDict of strings to the equivalent map", () => {
        expect(convertQueryDictToMap({ a: "b", c: "d" })).toEqual(
            new Map([
                ["a", "b"],
                ["c", "d"],
            ]),
        );
    });

    it("converts the values of the supplied QueryDict to strings", () => {
        expect(convertQueryDictToMap({ arr: ["b", "c"], num: 45, boo: true, und: undefined })).toEqual(
            new Map([
                ["arr", "b,c"],
                ["num", "45"],
                ["boo", "true"],
                ["und", "undefined"],
            ]),
        );
    });

    it("produces sane URLSearchParams conversions", () => {
        expect(new URLSearchParams(Array.from(convertQueryDictToMap({ a: "b", c: "d" }))).toString()).toEqual(
            "a=b&c=d",
        );
    });
});

describe("MatrixClient", function () {
    const userId = "@alice:bar";
    const identityServerUrl = "https://identity.server";
    const identityServerDomain = "identity.server";

    /**
     * @deprecated this is hard to use correctly; better to create a regular client with {@link createClient}
     * and use fetch-mock.
     */
    let client: MatrixClient;
    let store: Store;
    let scheduler: MatrixScheduler;

    const KEEP_ALIVE_PATH = "/_matrix/client/versions";

    const PUSH_RULES_RESPONSE: HttpLookup = {
        method: "GET",
        path: "/pushrules/",
        data: {},
    };

    const FILTER_PATH = "/user/" + encodeURIComponent(userId) + "/filter";

    const FILTER_RESPONSE: HttpLookup = {
        method: "POST",
        path: FILTER_PATH,
        data: { filter_id: "f1lt3r" },
    };

    const SYNC_DATA = {
        next_batch: "s_5_3",
        presence: { events: [] },
        rooms: {},
    };

    const SYNC_RESPONSE: HttpLookup = {
        method: "GET",
        path: "/sync",
        data: SYNC_DATA,
    };

    let unstableFeatures: Record<string, boolean> = {};

    // items are popped off when processed and block if no items left.
    let httpLookups: HttpLookup[] = [];
    let acceptKeepalives: boolean;
    let pendingLookup: {
        promise: Promise<any>;
        method: string;
        path: string;
    } | null = null;
    function httpReq(
        method: Method,
        path: string,
        queryParams?: QueryDict,
        body?: BodyInit,
        requestOpts: IRequestOpts = {},
    ) {
        const { prefix } = requestOpts;
        if (path === KEEP_ALIVE_PATH && acceptKeepalives) {
            return Promise.resolve({
                unstable_features: unstableFeatures,
                versions: ["v1.1"],
            });
        }
        const next = httpLookups.shift();
        const logLine =
            "MatrixClient[UT] RECV " +
            method +
            " " +
            path +
            "  " +
            "EXPECT " +
            (next ? next.method : next) +
            " " +
            (next ? next.path : next);
        logger.log(logLine);

        if (!next) {
            // no more things to return
            if (pendingLookup) {
                if (pendingLookup.method === method && pendingLookup.path === path) {
                    return pendingLookup.promise;
                }
                // >1 pending thing, and they are different, whine.
                expect(false).toBe(true);
            }
            pendingLookup = {
                promise: new Promise(() => {}),
                method: method,
                path: path,
            };
            return pendingLookup.promise;
        }
        // Either we don't care about the prefix if it wasn't defined in the expected
        // lookup or it should match.
        const doesMatchPrefix = !next.prefix || next.prefix === prefix;
        if (doesMatchPrefix && next.path === path && next.method === method) {
            logger.log("MatrixClient[UT] Matched. Returning " + (next.error ? "BAD" : "GOOD") + " response");
            if (next.expectBody) {
                expect(body).toEqual(next.expectBody);
            }
            if (next.expectQueryParams) {
                Object.keys(next.expectQueryParams).forEach(function (k) {
                    expect(queryParams?.[k]).toEqual(next.expectQueryParams![k]);
                });
            }

            if (next.thenCall) {
                process.nextTick(next.thenCall, 0); // next tick so we return first.
            }

            if (next.error) {
                // eslint-disable-next-line
                return Promise.reject(
                    new MatrixError(
                        {
                            errcode: (<MatrixError>next.error).errcode,
                            name: (<MatrixError>next.error).errcode,
                            message: "Expected testing error",
                            data: next.error,
                        },
                        (<MatrixError>next.error).httpStatus,
                    ),
                );
            }
            return Promise.resolve(next.data);
        }

        const receivedRequestQueryString = new URLSearchParams(
            Array.from(convertQueryDictToMap(queryParams)),
        ).toString();
        const receivedRequestDebugString = `${method} ${prefix}${path}${receivedRequestQueryString}`;
        const expectedQueryString = new URLSearchParams(
            Array.from(convertQueryDictToMap(next.expectQueryParams)),
        ).toString();
        const expectedRequestDebugString = `${next.method} ${next.prefix ?? ""}${next.path}${expectedQueryString}`;
        // If you're seeing this then you forgot to handle at least 1 pending request.
        throw new Error(
            `A pending request was not handled: ${receivedRequestDebugString} ` +
                `(next request expected was ${expectedRequestDebugString})\n` +
                `Check your tests to ensure your number of expectations lines up with your number of requests ` +
                `made, and that those requests match your expectations.`,
        );
    }

    function makeClient(opts?: Partial<IMatrixClientCreateOpts>) {
        client = new MatrixClient({
            baseUrl: "https://my.home.server",
            idBaseUrl: identityServerUrl,
            accessToken: "my.access.token",
            fetchFn: function () {} as any, // NOP
            store: store,
            scheduler: scheduler,
            userId: userId,
            ...(opts || {}),
        });
        // FIXME: We shouldn't be yanking http like this.
        client.http = (
            ["authedRequest", "getContentUri", "request", "uploadContent", "idServerRequest"] as const
        ).reduce((r, k) => {
            r[k] = jest.fn();
            return r;
        }, {} as MatrixHttpApi<any>);
        mocked(client.http.authedRequest).mockImplementation(httpReq);
        mocked(client.http.request).mockImplementation(httpReq);
    }

    beforeEach(function () {
        scheduler = (["getQueueForEvent", "queueEvent", "removeEventFromQueue", "setProcessFunction"] as const).reduce(
            (r, k) => {
                r[k] = jest.fn();
                return r;
            },
            {} as MatrixScheduler,
        );
        store = (
            [
                "getRoom",
                "getRooms",
                "getUser",
                "getSyncToken",
                "scrollback",
                "save",
                "wantsSave",
                "setSyncToken",
                "storeEvents",
                "storeRoom",
                "storeUser",
                "getFilterIdByName",
                "setFilterIdByName",
                "getFilter",
                "storeFilter",
                "startup",
                "deleteAllData",
                "setUserCreator",
            ] as const
        ).reduce((r, k) => {
            r[k] = jest.fn();
            return r;
        }, {} as Store);
        store.getSavedSync = jest.fn().mockReturnValue(Promise.resolve(null));
        store.getSavedSyncToken = jest.fn().mockReturnValue(Promise.resolve(null));
        store.setSyncData = jest.fn().mockReturnValue(Promise.resolve(null));
        store.getClientOptions = jest.fn().mockReturnValue(Promise.resolve(null));
        store.storeClientOptions = jest.fn().mockReturnValue(Promise.resolve(null));
        store.isNewlyCreated = jest.fn().mockReturnValue(Promise.resolve(true));

        // set unstableFeatures to a defined state before each test
        unstableFeatures = {
            "org.matrix.msc3440.stable": true,
        };

        makeClient();

        // set reasonable working defaults
        acceptKeepalives = true;
        pendingLookup = null;
        httpLookups = [];
        httpLookups.push(PUSH_RULES_RESPONSE);
        httpLookups.push(FILTER_RESPONSE);
        httpLookups.push(SYNC_RESPONSE);
    });

    afterEach(function () {
        // need to re-stub the requests with NOPs because there are no guarantees
        // clients from previous tests will be GC'd before the next test. This
        // means they may call /events and then fail an expect() which will fail
        // a DIFFERENT test (pollution between tests!) - we return unresolved
        // promises to stop the client from continuing to run.
        mocked(client.http.authedRequest).mockImplementation(function () {
            return new Promise(() => {});
        });
        client.stopClient();
    });

    describe("mxcUrlToHttp", () => {
        it("should call getHttpUriForMxc", () => {
            const mxc = "mxc://server/example";
            expect(client.mxcUrlToHttp(mxc)).toBe(getHttpUriForMxc(client.baseUrl, mxc));
            expect(client.mxcUrlToHttp(mxc, 32)).toBe(getHttpUriForMxc(client.baseUrl, mxc, 32));
            expect(client.mxcUrlToHttp(mxc, 32, 46)).toBe(getHttpUriForMxc(client.baseUrl, mxc, 32, 46));
            expect(client.mxcUrlToHttp(mxc, 32, 46, "scale")).toBe(
                getHttpUriForMxc(client.baseUrl, mxc, 32, 46, "scale"),
            );
            expect(client.mxcUrlToHttp(mxc, 32, 46, "scale", false, true)).toBe(
                getHttpUriForMxc(client.baseUrl, mxc, 32, 46, "scale", false, true),
            );
            expect(client.mxcUrlToHttp(mxc, 32, 46, "scale", false, true, true)).toBe(
                getHttpUriForMxc(client.baseUrl, mxc, 32, 46, "scale", false, true, true),
            );
        });
    });

    describe("timestampToEvent", () => {
        const roomId = "!room:server.org";
        const eventId = "$eventId:example.org";
        const unstableMSC3030Prefix = "/_matrix/client/unstable/org.matrix.msc3030";

        async function assertRequestsMade(
            responses: {
                prefix?: string;
                error?: { httpStatus: number; errcode: string };
                data?: { event_id: string };
            }[],
            expectRejects = false,
        ) {
            const queryParams = {
                ts: "0",
                dir: "f",
            };
            const path = `/rooms/${encodeURIComponent(roomId)}/timestamp_to_event`;
            // Set up the responses we are going to send back
            httpLookups = responses.map((res) => {
                return {
                    method: "GET",
                    path,
                    expectQueryParams: queryParams,
                    ...res,
                };
            });

            // When we ask for the event timestamp (this is what we are testing)
            const answer = client.timestampToEvent(roomId, 0, Direction.Forward);

            if (expectRejects) {
                await expect(answer).rejects.toBeDefined();
            } else {
                await answer;
            }

            // Then the number of requests me made matches our expectation
            const calls = mocked(client.http.authedRequest).mock.calls;
            expect(calls.length).toStrictEqual(responses.length);

            // And each request was as we expected
            let i = 0;
            for (const call of calls) {
                const response = responses[i];
                const [callMethod, callPath, callQueryParams, , callOpts] = call;
                const callPrefix = callOpts?.prefix;

                expect(callMethod).toStrictEqual("GET");
                if (response.prefix) {
                    expect(callPrefix).toStrictEqual(response.prefix);
                }
                expect(callPath).toStrictEqual(path);
                expect(callQueryParams).toStrictEqual(queryParams);
                i++;
            }
        }

        it("should call stable endpoint", async () => {
            await assertRequestsMade([
                {
                    data: { event_id: eventId },
                },
            ]);
        });

        it("should fallback to unstable endpoint when stable endpoint 400s", async () => {
            await assertRequestsMade([
                {
                    prefix: ClientPrefix.V1,
                    error: {
                        httpStatus: 400,
                        errcode: "M_UNRECOGNIZED",
                    },
                },
                {
                    prefix: unstableMSC3030Prefix,
                    data: { event_id: eventId },
                },
            ]);
        });

        it("should fallback to unstable endpoint when stable endpoint 404s", async () => {
            await assertRequestsMade([
                {
                    prefix: ClientPrefix.V1,
                    error: {
                        httpStatus: 404,
                        errcode: "M_UNRECOGNIZED",
                    },
                },
                {
                    prefix: unstableMSC3030Prefix,
                    data: { event_id: eventId },
                },
            ]);
        });

        it("should fallback to unstable endpoint when stable endpoint 405s", async () => {
            await assertRequestsMade([
                {
                    prefix: ClientPrefix.V1,
                    error: {
                        httpStatus: 405,
                        errcode: "M_UNRECOGNIZED",
                    },
                },
                {
                    prefix: unstableMSC3030Prefix,
                    data: { event_id: eventId },
                },
            ]);
        });

        it("should not fallback to unstable endpoint when stable endpoint returns an error (500)", async () => {
            await assertRequestsMade(
                [
                    {
                        prefix: ClientPrefix.V1,
                        error: {
                            httpStatus: 500,
                            errcode: "Fake response error",
                        },
                    },
                ],
                true,
            );
        });

        it("should not fallback to unstable endpoint when stable endpoint is rate-limiting (429)", async () => {
            await assertRequestsMade(
                [
                    {
                        prefix: ClientPrefix.V1,
                        error: {
                            httpStatus: 429,
                            errcode: "M_UNRECOGNIZED", // Still refuses even if the errcode claims unrecognised
                        },
                    },
                ],
                true,
            );
        });

        it("should not fallback to unstable endpoint when stable endpoint says bad gateway (502)", async () => {
            await assertRequestsMade(
                [
                    {
                        prefix: ClientPrefix.V1,
                        error: {
                            httpStatus: 502,
                            errcode: "Fake response error",
                        },
                    },
                ],
                true,
            );
        });
    });

    describe("getSafeUserId()", () => {
        it("returns the logged in user id", () => {
            expect(client.getSafeUserId()).toEqual(userId);
        });

        it("throws when there is not logged in user", () => {
            const notLoggedInClient = new MatrixClient({
                baseUrl: "https://my.home.server",
                idBaseUrl: identityServerUrl,
                fetchFn: function () {} as any, // NOP
                store: store,
                scheduler: scheduler,
            });
            expect(() => notLoggedInClient.getSafeUserId()).toThrow("Expected logged in user but found none.");
        });
    });

    describe("reportRoom", function () {
        const roomId = "!foo:bar";
        const reason = "rubbish room";

        it("should send an invite HTTP POST", async function () {
            httpLookups = [
                {
                    method: "POST",
                    path: "/rooms/!foo%3Abar/report",
                    data: {},
                    expectBody: {
                        reason,
                    },
                },
            ];
            await client.reportRoom(roomId, reason);
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("sendEvent", () => {
        const roomId = "!room:example.org";
        const body = "This is the body";
        const content = { body, msgtype: MsgType.Text } satisfies RoomMessageEventContent;

        it("overload without threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                    data: { event_id: eventId },
                    expectBody: content,
                },
            ];

            await client.sendEvent(roomId, EventType.RoomMessage, { ...content }, txnId);
        });

        it("overload with null threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                    data: { event_id: eventId },
                    expectBody: content,
                },
            ];

            await client.sendEvent(roomId, null, EventType.RoomMessage, { ...content }, txnId);
        });

        it("overload with threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            const threadId = "$threadId:server";
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                    data: { event_id: eventId },
                    expectBody: {
                        ...content,
                        "m.relates_to": {
                            event_id: threadId,
                            is_falling_back: true,
                            rel_type: "m.thread",
                        },
                    },
                },
            ];

            await client.sendEvent(roomId, threadId, EventType.RoomMessage, { ...content }, txnId);
        });

        it("should add thread relation if threadId is passed and the relation is missing", async () => {
            const eventId = "$eventId:example.org";
            const threadId = "$threadId:server";
            const txnId = client.makeTxnId();

            const room = new Room(roomId, client, userId);
            mocked(store.getRoom).mockReturnValue(room);

            const rootEvent = new MatrixEvent({ event_id: threadId });
            room.createThread(threadId, rootEvent, [rootEvent], false);

            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                    data: { event_id: eventId },
                    expectBody: {
                        ...content,
                        "m.relates_to": {
                            "m.in_reply_to": {
                                event_id: threadId,
                            },
                            "event_id": threadId,
                            "is_falling_back": true,
                            "rel_type": "m.thread",
                        },
                    },
                },
            ];

            await client.sendEvent(roomId, threadId, EventType.RoomMessage, { ...content }, txnId);
        });

        it("should add thread relation if threadId is passed and the relation is missing with reply", async () => {
            const eventId = "$eventId:example.org";
            const threadId = "$threadId:server";
            const txnId = client.makeTxnId();

            const content = {
                body,
                "msgtype": MsgType.Text,
                "m.relates_to": {
                    "m.in_reply_to": {
                        event_id: "$other:event",
                    },
                },
            } satisfies RoomMessageEventContent;

            const room = new Room(roomId, client, userId);
            mocked(store.getRoom).mockReturnValue(room);

            const rootEvent = new MatrixEvent({ event_id: threadId });
            room.createThread(threadId, rootEvent, [rootEvent], false);

            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
                    data: { event_id: eventId },
                    expectBody: {
                        ...content,
                        "m.relates_to": {
                            "m.in_reply_to": {
                                event_id: "$other:event",
                            },
                            "event_id": threadId,
                            "is_falling_back": false,
                            "rel_type": "m.thread",
                        },
                    },
                },
            ];

            await client.sendEvent(roomId, threadId, EventType.RoomMessage, { ...content }, txnId);
        });
    });

    describe("_unstable_sendDelayedEvent", () => {
        const unstableMSC4140Prefix = `${ClientPrefix.Unstable}/org.matrix.msc4140`;

        const roomId = "!room:example.org";
        const body = "This is the body";
        const content = { body, msgtype: MsgType.Text } satisfies RoomMessageEventContent;
        const timeoutDelayOpts = { delay: 2000 };
        const realTimeoutDelayOpts = { "org.matrix.msc4140.delay": 2000 };

        beforeEach(() => {
            unstableFeatures["org.matrix.msc4140"] = true;
        });

        it("throws when unsupported by server", async () => {
            unstableFeatures["org.matrix.msc4140"] = false;
            const errorMessage = "Server does not support";

            await expect(
                client._unstable_sendDelayedEvent(
                    roomId,
                    timeoutDelayOpts,
                    null,
                    EventType.RoomMessage,
                    { ...content },
                    client.makeTxnId(),
                ),
            ).rejects.toThrow(errorMessage);

            await expect(
                client._unstable_sendDelayedStateEvent(roomId, timeoutDelayOpts, EventType.RoomTopic, {
                    topic: "topic",
                }),
            ).rejects.toThrow(errorMessage);

            await expect(client._unstable_getDelayedEvents()).rejects.toThrow(errorMessage);

            await expect(
                client._unstable_updateDelayedEvent("anyDelayId", UpdateDelayedEventAction.Send),
            ).rejects.toThrow(errorMessage);
        });

        it("works with null threadId", async () => {
            httpLookups = [];

            const timeoutDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${timeoutDelayTxnId}`,
                expectQueryParams: realTimeoutDelayOpts,
                data: { delay_id: "id1" },
                expectBody: content,
            });

            const { delay_id: timeoutDelayId } = await client._unstable_sendDelayedEvent(
                roomId,
                timeoutDelayOpts,
                null,
                EventType.RoomMessage,
                { ...content },
                timeoutDelayTxnId,
            );

            const actionDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${actionDelayTxnId}`,
                expectQueryParams: { "org.matrix.msc4140.parent_delay_id": timeoutDelayId },
                data: { delay_id: "id2" },
                expectBody: content,
            });

            await client._unstable_sendDelayedEvent(
                roomId,
                { parent_delay_id: timeoutDelayId },
                null,
                EventType.RoomMessage,
                { ...content },
                actionDelayTxnId,
            );
        });

        it("works with non-null threadId", async () => {
            httpLookups = [];
            const threadId = "$threadId:server";
            const expectBody = {
                ...content,
                "m.relates_to": {
                    event_id: threadId,
                    is_falling_back: true,
                    rel_type: "m.thread",
                },
            };

            const timeoutDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${timeoutDelayTxnId}`,
                expectQueryParams: realTimeoutDelayOpts,
                data: { delay_id: "id1" },
                expectBody,
            });

            const { delay_id: timeoutDelayId } = await client._unstable_sendDelayedEvent(
                roomId,
                timeoutDelayOpts,
                threadId,
                EventType.RoomMessage,
                { ...content },
                timeoutDelayTxnId,
            );

            const actionDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${actionDelayTxnId}`,
                expectQueryParams: { "org.matrix.msc4140.parent_delay_id": timeoutDelayId },
                data: { delay_id: "id2" },
                expectBody,
            });

            await client._unstable_sendDelayedEvent(
                roomId,
                { parent_delay_id: timeoutDelayId },
                threadId,
                EventType.RoomMessage,
                { ...content },
                actionDelayTxnId,
            );
        });

        it("should add thread relation if threadId is passed and the relation is missing", async () => {
            httpLookups = [];
            const threadId = "$threadId:server";
            const expectBody = {
                ...content,
                "m.relates_to": {
                    "m.in_reply_to": {
                        event_id: threadId,
                    },
                    "event_id": threadId,
                    "is_falling_back": true,
                    "rel_type": "m.thread",
                },
            };

            const room = new Room(roomId, client, userId);
            mocked(store.getRoom).mockReturnValue(room);

            const rootEvent = new MatrixEvent({ event_id: threadId });
            room.createThread(threadId, rootEvent, [rootEvent], false);

            const timeoutDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${timeoutDelayTxnId}`,
                expectQueryParams: realTimeoutDelayOpts,
                data: { delay_id: "id1" },
                expectBody,
            });

            const { delay_id: timeoutDelayId } = await client._unstable_sendDelayedEvent(
                roomId,
                timeoutDelayOpts,
                threadId,
                EventType.RoomMessage,
                { ...content },
                timeoutDelayTxnId,
            );

            const actionDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${actionDelayTxnId}`,
                expectQueryParams: { "org.matrix.msc4140.parent_delay_id": timeoutDelayId },
                data: { delay_id: "id2" },
                expectBody,
            });

            await client._unstable_sendDelayedEvent(
                roomId,
                { parent_delay_id: timeoutDelayId },
                threadId,
                EventType.RoomMessage,
                { ...content },
                actionDelayTxnId,
            );
        });

        it("should add thread relation if threadId is passed and the relation is missing with reply", async () => {
            httpLookups = [];
            const threadId = "$threadId:server";

            const content = {
                body,
                "msgtype": MsgType.Text,
                "m.relates_to": {
                    "m.in_reply_to": {
                        event_id: "$other:event",
                    },
                },
            } satisfies RoomMessageEventContent;
            const expectBody = {
                ...content,
                "m.relates_to": {
                    "m.in_reply_to": {
                        event_id: "$other:event",
                    },
                    "event_id": threadId,
                    "is_falling_back": false,
                    "rel_type": "m.thread",
                },
            };

            const room = new Room(roomId, client, userId);
            mocked(store.getRoom).mockReturnValue(room);

            const rootEvent = new MatrixEvent({ event_id: threadId });
            room.createThread(threadId, rootEvent, [rootEvent], false);

            const timeoutDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${timeoutDelayTxnId}`,
                expectQueryParams: realTimeoutDelayOpts,
                data: { delay_id: "id1" },
                expectBody,
            });

            const { delay_id: timeoutDelayId } = await client._unstable_sendDelayedEvent(
                roomId,
                timeoutDelayOpts,
                threadId,
                EventType.RoomMessage,
                { ...content },
                timeoutDelayTxnId,
            );

            const actionDelayTxnId = client.makeTxnId();
            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${actionDelayTxnId}`,
                expectQueryParams: { "org.matrix.msc4140.parent_delay_id": timeoutDelayId },
                data: { delay_id: "id2" },
                expectBody,
            });

            await client._unstable_sendDelayedEvent(
                roomId,
                { parent_delay_id: timeoutDelayId },
                threadId,
                EventType.RoomMessage,
                { ...content },
                actionDelayTxnId,
            );
        });

        it("can send a delayed state event", async () => {
            httpLookups = [];
            const content = { topic: "The year 2000" };

            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/state/m.room.topic/`,
                expectQueryParams: realTimeoutDelayOpts,
                data: { delay_id: "id1" },
                expectBody: content,
            });

            const { delay_id: timeoutDelayId } = await client._unstable_sendDelayedStateEvent(
                roomId,
                timeoutDelayOpts,
                EventType.RoomTopic,
                { ...content },
            );

            httpLookups.push({
                method: "PUT",
                path: `/rooms/${encodeURIComponent(roomId)}/state/m.room.topic/`,
                expectQueryParams: { "org.matrix.msc4140.parent_delay_id": timeoutDelayId },
                data: { delay_id: "id2" },
                expectBody: content,
            });

            await client._unstable_sendDelayedStateEvent(
                roomId,
                { parent_delay_id: timeoutDelayId },
                EventType.RoomTopic,
                { ...content },
            );
        });

        it("can look up delayed events", async () => {
            httpLookups = [
                {
                    method: "GET",
                    prefix: unstableMSC4140Prefix,
                    path: "/delayed_events",
                    data: [],
                },
            ];

            await client._unstable_getDelayedEvents();
        });

        it("can update delayed events", async () => {
            const delayId = "id";
            const action = UpdateDelayedEventAction.Restart;
            httpLookups = [
                {
                    method: "POST",
                    prefix: unstableMSC4140Prefix,
                    path: `/delayed_events/${encodeURIComponent(delayId)}`,
                    data: {
                        action,
                    },
                },
            ];

            await client._unstable_updateDelayedEvent(delayId, action);
        });
    });

    describe("extended profiles", () => {
        const unstableMSC4133Prefix = `${ClientPrefix.Unstable}/uk.tcpip.msc4133`;
        const userId = "@profile_user:example.org";

        beforeEach(() => {
            unstableFeatures["uk.tcpip.msc4133"] = true;
        });

        it("throws when unsupported by server", async () => {
            unstableFeatures["uk.tcpip.msc4133"] = false;
            const errorMessage = "Server does not support extended profiles";

            await expect(client.doesServerSupportExtendedProfiles()).resolves.toEqual(false);

            await expect(client.getExtendedProfile(userId)).rejects.toThrow(errorMessage);
            await expect(client.getExtendedProfileProperty(userId, "test_key")).rejects.toThrow(errorMessage);
            await expect(client.setExtendedProfileProperty("test_key", "foo")).rejects.toThrow(errorMessage);
            await expect(client.deleteExtendedProfileProperty("test_key")).rejects.toThrow(errorMessage);
            await expect(client.patchExtendedProfile({ test_key: "foo" })).rejects.toThrow(errorMessage);
            await expect(client.setExtendedProfile({ test_key: "foo" })).rejects.toThrow(errorMessage);
        });

        it("can fetch a extended user profile", async () => {
            const testProfile = {
                test_key: "foo",
            };
            httpLookups = [
                {
                    method: "GET",
                    prefix: unstableMSC4133Prefix,
                    path: "/profile/" + encodeURIComponent(userId),
                    data: testProfile,
                },
            ];
            await expect(client.getExtendedProfile(userId)).resolves.toEqual(testProfile);
            expect(httpLookups).toHaveLength(0);
        });

        it("can fetch a property from a extended user profile", async () => {
            const testProfile = {
                test_key: "foo",
            };
            httpLookups = [
                {
                    method: "GET",
                    prefix: unstableMSC4133Prefix,
                    path: "/profile/" + encodeURIComponent(userId) + "/test_key",
                    data: testProfile,
                },
            ];
            await expect(client.getExtendedProfileProperty(userId, "test_key")).resolves.toEqual("foo");
            expect(httpLookups).toHaveLength(0);
        });

        it("can set a property in our extended profile", async () => {
            httpLookups = [
                {
                    method: "PUT",
                    prefix: unstableMSC4133Prefix,
                    path: "/profile/" + encodeURIComponent(client.credentials.userId!) + "/test_key",
                    expectBody: {
                        test_key: "foo",
                    },
                },
            ];
            await expect(client.setExtendedProfileProperty("test_key", "foo")).resolves.toEqual(undefined);
            expect(httpLookups).toHaveLength(0);
        });

        it("can delete a property in our extended profile", async () => {
            httpLookups = [
                {
                    method: "DELETE",
                    prefix: unstableMSC4133Prefix,
                    path: "/profile/" + encodeURIComponent(client.credentials.userId!) + "/test_key",
                },
            ];
            await expect(client.deleteExtendedProfileProperty("test_key")).resolves.toEqual(undefined);
            expect(httpLookups).toHaveLength(0);
        });

        it("can patch our extended profile", async () => {
            const testProfile = {
                test_key: "foo",
            };
            const patchedProfile = {
                existing: "key",
                test_key: "foo",
            };
            httpLookups = [
                {
                    method: "PATCH",
                    prefix: unstableMSC4133Prefix,
                    path: "/profile/" + encodeURIComponent(client.credentials.userId!),
                    data: patchedProfile,
                    expectBody: testProfile,
                },
            ];
            await expect(client.patchExtendedProfile(testProfile)).resolves.toEqual(patchedProfile);
        });

        it("can replace our extended profile", async () => {
            const testProfile = {
                test_key: "foo",
            };
            httpLookups = [
                {
                    method: "PUT",
                    prefix: unstableMSC4133Prefix,
                    path: "/profile/" + encodeURIComponent(client.credentials.userId!),
                    data: testProfile,
                    expectBody: testProfile,
                },
            ];
            await expect(client.setExtendedProfile(testProfile)).resolves.toEqual(undefined);
        });
    });

    it("should create (unstable) file trees", async () => {
        const userId = "@test:example.org";
        const roomId = "!room:example.org";
        const roomName = "Test Tree";
        const mockRoom = {} as unknown as Room;
        const fn = jest.fn().mockImplementation((opts) => {
            expect(opts).toMatchObject({
                name: roomName,
                preset: Preset.PrivateChat,
                power_level_content_override: {
                    ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE,
                    users: {
                        [userId]: 100,
                    },
                },
                creation_content: {
                    [RoomCreateTypeField]: RoomType.Space,
                },
                initial_state: [
                    {
                        // We use `unstable` to ensure that the code is actually using the right identifier
                        type: UNSTABLE_MSC3088_PURPOSE.unstable,
                        state_key: UNSTABLE_MSC3089_TREE_SUBTYPE.unstable,
                        content: {
                            [UNSTABLE_MSC3088_ENABLED.unstable!]: true,
                        },
                    },
                    {
                        type: EventType.RoomEncryption,
                        state_key: "",
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                        },
                    },
                ],
            });
            return { room_id: roomId };
        });
        client.getUserId = () => userId;
        client.createRoom = fn;
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = await client.unstableCreateFileTree(roomName);
        expect(tree).toBeDefined();
        expect(tree.roomId).toEqual(roomId);
        expect(tree.room).toBe(mockRoom);
        expect(fn.mock.calls.length).toBe(1);
    });

    it("should get (unstable) file trees with valid state", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => KnownMembership.Join,
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    /* eslint-disable jest/no-conditional-expect */
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: RoomType.Space,
                            },
                        });
                    } else if (eventType === UNSTABLE_MSC3088_PURPOSE.unstable) {
                        // We use `unstable` to ensure that the code is actually using the right identifier
                        expect(stateKey).toEqual(UNSTABLE_MSC3089_TREE_SUBTYPE.unstable);
                        return new MatrixEvent({
                            content: {
                                [UNSTABLE_MSC3088_ENABLED.unstable!]: true,
                            },
                        });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                    /* eslint-enable jest/no-conditional-expect */
                },
            } as Room["currentState"],
        } as unknown as Room;
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeDefined();
        expect(tree!.roomId).toEqual(roomId);
        expect(tree!.room).toBe(mockRoom);
    });

    it("should not get (unstable) file trees if not joined", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => KnownMembership.Leave, // "not join"
        } as unknown as Room;
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not get (unstable) file trees for unknown rooms", async () => {
        const roomId = "!room:example.org";
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return null; // imply unknown
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not get (unstable) file trees with invalid create contents", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => KnownMembership.Join,
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    /* eslint-disable jest/no-conditional-expect */
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: "org.example.not_space",
                            },
                        });
                    } else if (eventType === UNSTABLE_MSC3088_PURPOSE.unstable) {
                        // We use `unstable` to ensure that the code is actually using the right identifier
                        expect(stateKey).toEqual(UNSTABLE_MSC3089_TREE_SUBTYPE.unstable);
                        return new MatrixEvent({
                            content: {
                                [UNSTABLE_MSC3088_ENABLED.unstable!]: true,
                            },
                        });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                    /* eslint-enable jest/no-conditional-expect */
                },
            } as Room["currentState"],
        } as unknown as Room;
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not get (unstable) file trees with invalid purpose/subtype contents", async () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => KnownMembership.Join,
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    /* eslint-disable jest/no-conditional-expect */
                    if (eventType === EventType.RoomCreate) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({
                            content: {
                                [RoomCreateTypeField]: RoomType.Space,
                            },
                        });
                    } else if (eventType === UNSTABLE_MSC3088_PURPOSE.unstable) {
                        expect(stateKey).toEqual(UNSTABLE_MSC3089_TREE_SUBTYPE.unstable);
                        return new MatrixEvent({
                            content: {
                                [UNSTABLE_MSC3088_ENABLED.unstable!]: false,
                            },
                        });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                    /* eslint-enable jest/no-conditional-expect */
                },
            } as Room["currentState"],
        } as unknown as Room;
        client.getRoom = (getRoomId) => {
            expect(getRoomId).toEqual(roomId);
            return mockRoom;
        };
        const tree = client.unstableGetFileTreeSpace(roomId);
        expect(tree).toBeFalsy();
    });

    it("should not POST /filter if a matching filter already exists", async function () {
        httpLookups = [PUSH_RULES_RESPONSE, SYNC_RESPONSE];
        const filterId = "ehfewf";
        mocked(store.getFilterIdByName).mockReturnValue(filterId);
        const filter = new Filter("0", filterId);
        filter.setDefinition({ room: { timeline: { limit: 8 } } });
        mocked(store.getFilter).mockReturnValue(filter);
        const syncPromise = new Promise<void>((resolve, reject) => {
            client.on(ClientEvent.Sync, function syncListener(state) {
                if (state === "SYNCING") {
                    // eslint-disable-next-line jest/no-conditional-expect
                    expect(httpLookups.length).toEqual(0);
                    client.removeListener(ClientEvent.Sync, syncListener);
                    resolve();
                } else if (state === "ERROR") {
                    reject(new Error("sync error"));
                }
            });
        });
        await client.startClient({ filter });
        await syncPromise;
    });

    describe("getSyncState", function () {
        it("should return null if the client isn't started", function () {
            expect(client.getSyncState()).toBe(null);
        });

        it("should return the same sync state as emitted sync events", async function () {
            const syncingPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, function syncListener(state) {
                    expect(state).toEqual(client.getSyncState());
                    if (state === "SYNCING") {
                        client.removeListener(ClientEvent.Sync, syncListener);
                        resolve();
                    }
                });
            });
            await client.startClient();
            await syncingPromise;
        });
    });

    describe("getOrCreateFilter", function () {
        it("should POST createFilter if no id is present in localStorage", function () {});
        it("should use an existing filter if id is present in localStorage", function () {});
        it("should handle localStorage filterId missing from the server", async () => {
            function getFilterName(userId: string, suffix?: string) {
                // scope this on the user ID because people may login on many accounts
                // and they all need to be stored!
                return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
            }
            const invalidFilterId = "invalidF1lt3r";
            httpLookups = [];
            httpLookups.push({
                method: "GET",
                path: FILTER_PATH + "/" + invalidFilterId,
                error: {
                    errcode: "M_UNKNOWN",
                    name: "M_UNKNOWN",
                    message: "No row found",
                    data: { errcode: "M_UNKNOWN", error: "No row found" },
                    httpStatus: 404,
                },
            });
            httpLookups.push(FILTER_RESPONSE);
            mocked(store.getFilterIdByName).mockReturnValue(invalidFilterId);

            const filterName = getFilterName(client.credentials.userId!);
            client.store.setFilterIdByName(filterName, invalidFilterId);
            const filter = new Filter(client.credentials.userId);

            const filterId = await client.getOrCreateFilter(filterName, filter);
            expect(filterId).toEqual(!Array.isArray(FILTER_RESPONSE.data) && FILTER_RESPONSE.data?.filter_id);
        });
    });

    describe("retryImmediately", function () {
        it("should return false if there is no request waiting", async function () {
            httpLookups = [];
            await client.startClient();
            expect(client.retryImmediately()).toBe(false);
        });

        it("should work on /filter", async () => {
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "POST",
                path: FILTER_PATH,
                error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            const wasPreparedPromise = new Promise((resolve) => {
                client.on(ClientEvent.Sync, function syncListener(state) {
                    /* eslint-disable jest/no-conditional-expect */
                    if (state === "ERROR" && httpLookups.length > 0) {
                        expect(httpLookups.length).toEqual(2);
                        expect(client.retryImmediately()).toBe(true);
                        jest.advanceTimersByTime(1);
                    } else if (state === "PREPARED" && httpLookups.length === 0) {
                        client.removeListener(ClientEvent.Sync, syncListener);
                        resolve(null);
                    } else {
                        // unexpected state transition!
                        expect(state).toEqual(null);
                    }
                    /* eslint-enable jest/no-conditional-expect */
                });
            });
            await client.startClient();
            await wasPreparedPromise;
        });

        it("should work on /sync", async () => {
            httpLookups.push({
                method: "GET",
                path: "/sync",
                error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push({
                method: "GET",
                path: "/sync",
                data: SYNC_DATA,
            });

            const isSyncingPromise = new Promise((resolve) => {
                client.on(ClientEvent.Sync, function syncListener(state) {
                    if (state === "ERROR" && httpLookups.length > 0) {
                        /* eslint-disable jest/no-conditional-expect */
                        expect(httpLookups.length).toEqual(1);
                        expect(client.retryImmediately()).toBe(true);
                        /* eslint-enable jest/no-conditional-expect */
                        jest.advanceTimersByTime(1);
                    } else if (state === "RECONNECTING" && httpLookups.length > 0) {
                        jest.advanceTimersByTime(10000);
                    } else if (state === "SYNCING" && httpLookups.length === 0) {
                        client.removeListener(ClientEvent.Sync, syncListener);
                        resolve(null);
                    }
                });
            });
            await client.startClient();
            await isSyncingPromise;
        });

        it("should work on /pushrules", async () => {
            httpLookups = [];
            httpLookups.push({
                method: "GET",
                path: "/pushrules/",
                error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            const wasPreparedPromise = new Promise((resolve) => {
                client.on(ClientEvent.Sync, function syncListener(state) {
                    /* eslint-disable jest/no-conditional-expect */
                    if (state === "ERROR" && httpLookups.length > 0) {
                        expect(httpLookups.length).toEqual(3);
                        expect(client.retryImmediately()).toBe(true);
                        jest.advanceTimersByTime(1);
                    } else if (state === "PREPARED" && httpLookups.length === 0) {
                        client.removeListener(ClientEvent.Sync, syncListener);
                        resolve(null);
                    } else {
                        // unexpected state transition!
                        expect(state).toEqual(null);
                    }
                    /* eslint-enable jest/no-conditional-expect */
                });
            });
            await client.startClient();
            await wasPreparedPromise;
        });
    });

    describe("emitted sync events", function () {
        function syncChecker(expectedStates: [string, string | null][], done: () => void) {
            return function syncListener(state: SyncState, old: SyncState | null) {
                const expected = expectedStates.shift();
                logger.log("'sync' curr=%s old=%s EXPECT=%s", state, old, expected);
                if (!expected) {
                    done();
                    return;
                }
                expect(state).toEqual(expected[0]);
                expect(old).toEqual(expected[1]);
                if (expectedStates.length === 0) {
                    client.removeListener(ClientEvent.Sync, syncListener);
                    done();
                }
                // standard retry time is 5 to 10 seconds
                jest.advanceTimersByTime(10000);
            };
        }

        it("should transition null -> PREPARED after the first /sync", async () => {
            const expectedStates: [string, string | null][] = [];
            expectedStates.push(["PREPARED", null]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        it("should transition null -> ERROR after a failed /filter", async () => {
            const expectedStates: [string, string | null][] = [];
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push({
                method: "POST",
                path: FILTER_PATH,
                error: { errcode: "NOPE_NOPE_NOPE" },
            });
            expectedStates.push(["ERROR", null]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        // Disabled because now `startClient` makes a legit call to `/versions`
        // And those tests are really unhappy about it... Not possible to figure
        // out what a good resolution would look like
        it.skip("should transition ERROR -> CATCHUP after /sync if prev failed", async () => {
            const expectedStates: [string, string | null][] = [];
            acceptKeepalives = false;
            httpLookups = [];
            httpLookups.push(PUSH_RULES_RESPONSE);
            httpLookups.push(FILTER_RESPONSE);
            httpLookups.push({
                method: "GET",
                path: "/sync",
                error: { errcode: "NOPE_NOPE_NOPE" },
            });
            httpLookups.push({
                method: "GET",
                path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });
            httpLookups.push({
                method: "GET",
                path: KEEP_ALIVE_PATH,
                data: {},
            });
            httpLookups.push({
                method: "GET",
                path: "/sync",
                data: SYNC_DATA,
            });

            expectedStates.push(["RECONNECTING", null]);
            expectedStates.push(["ERROR", "RECONNECTING"]);
            expectedStates.push(["CATCHUP", "ERROR"]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        it("should transition PREPARED -> SYNCING after /sync", async () => {
            const expectedStates: [string, string | null][] = [];
            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        it.skip("should transition SYNCING -> ERROR after a failed /sync", async () => {
            acceptKeepalives = false;
            const expectedStates: [string, string | null][] = [];
            httpLookups.push({
                method: "GET",
                path: "/sync",
                error: { errcode: "NONONONONO" },
            });
            httpLookups.push({
                method: "GET",
                path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["RECONNECTING", "SYNCING"]);
            expectedStates.push(["ERROR", "RECONNECTING"]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        it.skip("should transition ERROR -> SYNCING after /sync if prev failed", async () => {
            const expectedStates: [string, string | null][] = [];
            httpLookups.push({
                method: "GET",
                path: "/sync",
                error: { errcode: "NONONONONO" },
            });
            httpLookups.push(SYNC_RESPONSE);

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["ERROR", "SYNCING"]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        it("should transition SYNCING -> SYNCING on subsequent /sync successes", async () => {
            const expectedStates: [string, string | null][] = [];
            httpLookups.push(SYNC_RESPONSE);
            httpLookups.push(SYNC_RESPONSE);

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["SYNCING", "SYNCING"]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });

        it.skip("should transition ERROR -> ERROR if keepalive keeps failing", async () => {
            acceptKeepalives = false;
            const expectedStates: [string, string | null][] = [];
            httpLookups.push({
                method: "GET",
                path: "/sync",
                error: { errcode: "NONONONONO" },
            });
            httpLookups.push({
                method: "GET",
                path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });
            httpLookups.push({
                method: "GET",
                path: KEEP_ALIVE_PATH,
                error: { errcode: "KEEPALIVE_FAIL" },
            });

            expectedStates.push(["PREPARED", null]);
            expectedStates.push(["SYNCING", "PREPARED"]);
            expectedStates.push(["RECONNECTING", "SYNCING"]);
            expectedStates.push(["ERROR", "RECONNECTING"]);
            expectedStates.push(["ERROR", "ERROR"]);
            const didSyncPromise = new Promise<void>((resolve) => {
                client.on(ClientEvent.Sync, syncChecker(expectedStates, resolve));
            });
            await client.startClient();
            await didSyncPromise;
        });
    });

    describe("inviteByEmail", function () {
        const roomId = "!foo:bar";

        it("should send an invite HTTP POST", function () {
            httpLookups = [
                {
                    method: "POST",
                    path: "/rooms/!foo%3Abar/invite",
                    data: {},
                    expectBody: {
                        id_server: identityServerDomain,
                        medium: "email",
                        address: "alice@gmail.com",
                    },
                },
            ];
            client.inviteByEmail(roomId, "alice@gmail.com");
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("guest rooms", function () {
        it("should only do /sync calls (without filter/pushrules)", async function () {
            httpLookups = []; // no /pushrules or /filter
            httpLookups.push({
                method: "GET",
                path: "/sync",
                data: SYNC_DATA,
            });
            client.setGuest(true);
            await client.startClient();
            expect(httpLookups.length).toBe(0);
        });

        it.skip("should be able to peek into a room using peekInRoom", function () {});
    });

    describe("getPresence", function () {
        it("should send a presence HTTP GET", function () {
            httpLookups = [
                {
                    method: "GET",
                    path: `/presence/${encodeURIComponent(userId)}/status`,
                    data: {
                        presence: "unavailable",
                        last_active_ago: 420845,
                    },
                },
            ];
            client.getPresence(userId);
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("redactEvent", () => {
        const roomId = "!room:example.org";
        const mockRoom = {
            getMyMembership: () => KnownMembership.Join,
            currentState: {
                getStateEvents: (eventType, stateKey) => {
                    if (eventType === EventType.RoomEncryption) {
                        expect(stateKey).toEqual("");
                        return new MatrixEvent({ content: {} });
                    } else {
                        throw new Error("Unexpected event type or state key");
                    }
                },
            } as Room["currentState"],
            getThread: jest.fn(),
            addPendingEvent: jest.fn(),
            updatePendingEvent: jest.fn(),
            reEmitter: {
                reEmit: jest.fn(),
            },
        } as unknown as Room;

        beforeEach(() => {
            client.getRoom = (getRoomId) => {
                expect(getRoomId).toEqual(roomId);
                return mockRoom;
            };
        });

        it("overload without threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                    data: { event_id: eventId },
                },
            ];

            await client.redactEvent(roomId, eventId, txnId);
        });

        it("overload with null threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                    data: { event_id: eventId },
                },
            ];

            await client.redactEvent(roomId, null, eventId, txnId);
        });

        it("overload with threadId works", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                    data: { event_id: eventId },
                },
            ];

            await client.redactEvent(roomId, "$threadId:server", eventId, txnId);
        });

        it("does not get wrongly encrypted", async () => {
            const eventId = "$eventId:example.org";
            const txnId = client.makeTxnId();
            const reason = "This is the redaction reason";
            httpLookups = [
                {
                    method: "PUT",
                    path: `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
                    expectBody: { reason }, // NOT ENCRYPTED
                    data: { event_id: eventId },
                },
            ];

            await client.redactEvent(roomId, eventId, txnId, { reason });
        });

        describe("when calling with 'with_rel_types'", () => {
            const eventId = "$event42:example.org";

            it("should raise an error if the server has no support for relation based redactions", async () => {
                // load supported features
                await client.getVersions();

                const txnId = client.makeTxnId();

                expect(() => {
                    client.redactEvent(roomId, eventId, txnId, {
                        with_rel_types: [RelationType.Reference],
                    });
                }).toThrow(
                    new Error(
                        "Server does not support relation based redactions " +
                            `roomId ${roomId} eventId ${eventId} txnId: ${txnId} threadId null`,
                    ),
                );
            });

            it("and the server has unstable support for relation based redactions, it should send 'org.matrix.msc3912.with_relations' in the request body", async () => {
                unstableFeatures["org.matrix.msc3912"] = true;
                // load supported features
                await client.getVersions();

                const txnId = client.makeTxnId();

                httpLookups = [
                    {
                        method: "PUT",
                        path:
                            `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}` +
                            `/${encodeURIComponent(txnId)}`,
                        expectBody: {
                            reason: "redaction test",
                            ["org.matrix.msc3912.with_relations"]: ["m.reference"],
                        },
                        data: { event_id: eventId },
                    },
                ];

                await client.redactEvent(roomId, eventId, txnId, {
                    reason: "redaction test",
                    with_rel_types: [RelationType.Reference],
                });
            });
        });
    });

    describe("cancelPendingEvent", () => {
        const roomId = "!room:server";
        const txnId = "m12345";

        const mockRoom = {
            getMyMembership: () => KnownMembership.Join,
            updatePendingEvent: (event: MatrixEvent, status: EventStatus) => event.setStatus(status),
            hasEncryptionStateEvent: jest.fn().mockReturnValue(true),
        } as unknown as Room;

        let mockCrypto: Mocked<CryptoBackend>;

        let event: MatrixEvent;
        beforeEach(async () => {
            event = new MatrixEvent({
                event_id: "~" + roomId + ":" + txnId,
                sender: client.credentials.userId!,
                room_id: roomId,
                origin_server_ts: new Date().getTime(),
            });
            event.setTxnId(txnId);

            client.getRoom = (getRoomId) => {
                expect(getRoomId).toEqual(roomId);
                return mockRoom;
            };
            mockCrypto = {
                isEncryptionEnabledInRoom: jest.fn().mockResolvedValue(true),
                encryptEvent: jest.fn(),
                stop: jest.fn(),
            } as unknown as Mocked<CryptoBackend>;
            client["cryptoBackend"] = mockCrypto;
        });

        function assertCancelled() {
            expect(event.status).toBe(EventStatus.CANCELLED);
            expect(client.scheduler?.removeEventFromQueue(event)).toBeFalsy();
            expect(httpLookups.filter((h) => h.path.includes("/send/")).length).toBe(0);
        }

        it("should cancel an event which is queued", () => {
            event.setStatus(EventStatus.QUEUED);
            client.scheduler?.queueEvent(event);
            client.cancelPendingEvent(event);
            assertCancelled();
        });

        it("should cancel an event which is encrypting", async () => {
            const encryptEventDefer = defer();
            mockCrypto.encryptEvent.mockReturnValue(encryptEventDefer.promise);

            const statusPromise = testUtils.emitPromise(event, "Event.status");
            // @ts-ignore protected method access
            const encryptAndSendPromise = client.encryptAndSendEvent(mockRoom, event);
            await statusPromise;
            expect(event.status).toBe(EventStatus.ENCRYPTING);
            client.cancelPendingEvent(event);
            assertCancelled();

            // now let the encryption complete, and check that the message is not sent.
            encryptEventDefer.resolve();
            await encryptAndSendPromise;
            assertCancelled();
        });

        it("should cancel an event which is not sent", () => {
            event.setStatus(EventStatus.NOT_SENT);
            client.cancelPendingEvent(event);
            assertCancelled();
        });

        it("should error when given any other event status", () => {
            event.setStatus(EventStatus.SENDING);
            expect(() => client.cancelPendingEvent(event)).toThrow("cannot cancel an event with status sending");
            expect(event.status).toBe(EventStatus.SENDING);
        });
    });

    describe("threads", () => {
        it.each([
            { startOpts: {}, hasThreadSupport: false },
            { startOpts: { threadSupport: true }, hasThreadSupport: true },
            { startOpts: { threadSupport: false }, hasThreadSupport: false },
        ])("enabled thread support for the SDK instance", async ({ startOpts, hasThreadSupport }) => {
            await client.startClient(startOpts);
            expect(client.supportsThreads()).toBe(hasThreadSupport);
        });

        it("partitions root events to room timeline and thread timeline", () => {
            const supportsThreads = client.supportsThreads;
            client.supportsThreads = () => true;
            const room = new Room("!room1:matrix.org", client, userId);

            const rootEvent = new MatrixEvent({
                content: {},
                origin_server_ts: 1,
                room_id: "!room1:matrix.org",
                sender: "@alice:matrix.org",
                type: "m.room.message",
                unsigned: {
                    "m.relations": {
                        "m.thread": {
                            latest_event: {},
                            count: 33,
                            current_user_participated: false,
                        },
                    },
                },
                event_id: "$ev1",
            });

            expect(rootEvent.isThreadRoot).toBe(true);

            const [roomEvents, threadEvents] = room.partitionThreadedEvents([rootEvent]);
            expect(roomEvents).toHaveLength(1);
            expect(threadEvents).toHaveLength(1);

            // Restore method
            client.supportsThreads = supportsThreads;
        });
    });

    describe("read-markers and read-receipts", () => {
        it("setRoomReadMarkers", () => {
            client.setRoomReadMarkersHttpRequest = jest.fn();
            const room = {
                hasPendingEvent: jest.fn().mockReturnValue(false),
                addLocalEchoReceipt: jest.fn(),
            } as unknown as Room;
            const rrEvent = new MatrixEvent({ event_id: "read_event_id" });
            const rpEvent = new MatrixEvent({ event_id: "read_private_event_id" });
            client.getRoom = () => room;

            client.setRoomReadMarkers("room_id", "read_marker_event_id", rrEvent, rpEvent);

            expect(client.setRoomReadMarkersHttpRequest).toHaveBeenCalledWith(
                "room_id",
                "read_marker_event_id",
                "read_event_id",
                "read_private_event_id",
            );
            expect(room.addLocalEchoReceipt).toHaveBeenCalledTimes(2);
            expect(room.addLocalEchoReceipt).toHaveBeenNthCalledWith(
                1,
                client.credentials.userId,
                rrEvent,
                ReceiptType.Read,
            );
            expect(room.addLocalEchoReceipt).toHaveBeenNthCalledWith(
                2,
                client.credentials.userId,
                rpEvent,
                ReceiptType.ReadPrivate,
            );
        });
    });

    describe("beacons", () => {
        const roomId = "!room:server.org";
        const content = makeBeaconInfoContent(100, true);

        beforeEach(() => {
            mocked(client.http.authedRequest).mockClear().mockResolvedValue({});
        });

        it("creates new beacon info", async () => {
            await client.unstable_createLiveBeacon(roomId, content);

            // event type combined
            const expectedEventType = M_BEACON_INFO.name;
            const [method, path, queryParams, requestContent] = mocked(client.http.authedRequest).mock.calls[0];
            expect(method).toBe("PUT");
            expect(path).toEqual(
                `/rooms/${encodeURIComponent(roomId)}/state/` +
                    `${encodeURIComponent(expectedEventType)}/${encodeURIComponent(userId)}`,
            );
            expect(queryParams).toBeFalsy();
            expect(requestContent).toEqual(content);
        });

        it("updates beacon info with specific event type", async () => {
            await client.unstable_setLiveBeacon(roomId, content);

            // event type combined
            const [, path, , requestContent] = mocked(client.http.authedRequest).mock.calls[0];
            expect(path).toEqual(
                `/rooms/${encodeURIComponent(roomId)}/state/` +
                    `${encodeURIComponent(M_BEACON_INFO.name)}/${encodeURIComponent(userId)}`,
            );
            expect(requestContent).toEqual(content);
        });

        describe("processBeaconEvents()", () => {
            it("does nothing when events is falsy", () => {
                const room = new Room(roomId, client, userId);
                const roomStateProcessSpy = jest.spyOn(room.currentState, "processBeaconEvents");

                client.processBeaconEvents(room, undefined);
                expect(roomStateProcessSpy).not.toHaveBeenCalled();
            });

            it("does nothing when events is of length 0", () => {
                const room = new Room(roomId, client, userId);
                const roomStateProcessSpy = jest.spyOn(room.currentState, "processBeaconEvents");

                client.processBeaconEvents(room, []);
                expect(roomStateProcessSpy).not.toHaveBeenCalled();
            });

            it("calls room states processBeaconEvents with events", () => {
                const room = new Room(roomId, client, userId);
                const roomStateProcessSpy = jest.spyOn(room.currentState, "processBeaconEvents");

                const messageEvent = testUtils.mkMessage({ room: roomId, user: userId, event: true });
                const beaconEvent = makeBeaconEvent(userId);

                client.processBeaconEvents(room, [messageEvent, beaconEvent]);
                expect(roomStateProcessSpy).toHaveBeenCalledWith([messageEvent, beaconEvent], client);
            });
        });
    });

    describe("setRoomTopic", () => {
        const roomId = "!foofoofoofoofoofoo:matrix.org";
        const createSendStateEventMock = (topic: string, htmlTopic?: string) => {
            return jest.fn().mockImplementation((roomId: string, eventType: string, content: any, stateKey: string) => {
                expect(roomId).toEqual(roomId);
                expect(eventType).toEqual(EventType.RoomTopic);
                expect(content).toMatchObject(ContentHelpers.makeTopicContent(topic, htmlTopic));
                expect(stateKey).toBeUndefined();
                return Promise.resolve();
            });
        };

        it("is called with plain text topic and sends state event", async () => {
            const sendStateEvent = createSendStateEventMock("pizza");
            client.sendStateEvent = sendStateEvent;
            await client.setRoomTopic(roomId, "pizza");
            expect(sendStateEvent).toHaveBeenCalledTimes(1);
        });

        it("is called with plain text topic and callback and sends state event", async () => {
            const sendStateEvent = createSendStateEventMock("pizza");
            client.sendStateEvent = sendStateEvent;
            await client.setRoomTopic(roomId, "pizza");
            expect(sendStateEvent).toHaveBeenCalledTimes(1);
        });

        it("is called with plain text and HTML topic and sends state event", async () => {
            const sendStateEvent = createSendStateEventMock("pizza", "<b>pizza</b>");
            client.sendStateEvent = sendStateEvent;
            await client.setRoomTopic(roomId, "pizza", "<b>pizza</b>");
            expect(sendStateEvent).toHaveBeenCalledTimes(1);
        });
    });

    describe("setPassword", () => {
        const auth = { session: "abcdef", type: "foo" };
        const newPassword = "newpassword";

        const passwordTest = (expectedRequestContent: any) => {
            const [method, path, queryParams, requestContent] = mocked(client.http.authedRequest).mock.calls[0];
            expect(method).toBe("POST");
            expect(path).toEqual("/account/password");
            expect(queryParams).toBeFalsy();
            expect(requestContent).toEqual(expectedRequestContent);
        };

        beforeEach(() => {
            mocked(client.http.authedRequest).mockClear().mockResolvedValue({});
        });

        it("no logout_devices specified", async () => {
            await client.setPassword(auth, newPassword);
            passwordTest({ auth, new_password: newPassword });
        });

        it("no logout_devices specified + callback", async () => {
            await client.setPassword(auth, newPassword);
            passwordTest({ auth, new_password: newPassword });
        });

        it("overload logoutDevices=true", async () => {
            await client.setPassword(auth, newPassword, true);
            passwordTest({ auth, new_password: newPassword, logout_devices: true });
        });

        it("overload logoutDevices=true + callback", async () => {
            await client.setPassword(auth, newPassword, true);
            passwordTest({ auth, new_password: newPassword, logout_devices: true });
        });

        it("overload logoutDevices=false", async () => {
            await client.setPassword(auth, newPassword, false);
            passwordTest({ auth, new_password: newPassword, logout_devices: false });
        });

        it("overload logoutDevices=false + callback", async () => {
            await client.setPassword(auth, newPassword, false);
            passwordTest({ auth, new_password: newPassword, logout_devices: false });
        });
    });

    describe("getLocalAliases", () => {
        it("should call the right endpoint", async () => {
            const response = {
                aliases: ["#woop:example.org", "#another:example.org"],
            };
            mocked(client.http.authedRequest).mockClear().mockResolvedValue(response);

            const roomId = "!whatever:example.org";
            const result = await client.getLocalAliases(roomId);

            // Current version of the endpoint we support is v3
            const [method, path, queryParams, data, opts] = mocked(client.http.authedRequest).mock.calls[0];
            expect(data).toBeFalsy();
            expect(method).toBe("GET");
            expect(path).toEqual(`/rooms/${encodeURIComponent(roomId)}/aliases`);
            expect(opts).toMatchObject({ prefix: "/_matrix/client/v3" });
            expect(queryParams).toBeFalsy();
            expect(result!.aliases).toEqual(response.aliases);
        });
    });

    describe("pollingTurnServers", () => {
        afterEach(() => {
            mocked(supportsMatrixCall).mockReset();
        });

        it("is false if the client isn't started", () => {
            expect(client.clientRunning).toBe(false);
            expect(client.pollingTurnServers).toBe(false);
        });

        it("is false if VoIP is not supported", async () => {
            mocked(supportsMatrixCall).mockReturnValue(false);
            makeClient(); // create the client a second time so it picks up the supportsMatrixCall mock
            await client.startClient();
            expect(client.pollingTurnServers).toBe(false);
        });

        it("is true if VoIP is supported", async () => {
            mocked(supportsMatrixCall).mockReturnValue(true);
            makeClient(); // create the client a second time so it picks up the supportsMatrixCall mock
            await client.startClient();
            expect(client.pollingTurnServers).toBe(true);
        });
    });

    describe("checkTurnServers", () => {
        beforeEach(() => {
            mocked(supportsMatrixCall).mockReturnValue(true);
        });

        beforeEach(() => {
            makeClient(); // create the client a second time so it picks up the supportsMatrixCall mock
        });

        afterAll(() => {
            mocked(supportsMatrixCall).mockReset();
        });

        it("emits an event when new TURN creds are found", async () => {
            const turnServer = {
                uris: [
                    "turn:turn.example.com:3478?transport=udp",
                    "turn:10.20.30.40:3478?transport=tcp",
                    "turns:10.20.30.40:443?transport=tcp",
                ],
                username: "1443779631:@user:example.com",
                password: "JlKfBy1QwLrO20385QyAtEyIv0=",
            } as unknown as ITurnServerResponse;
            jest.spyOn(client, "turnServer").mockResolvedValue(turnServer);

            const events: any[][] = [];
            const onTurnServers = (...args: any[]) => events.push(args);
            client.on(ClientEvent.TurnServers, onTurnServers);
            expect(await client.checkTurnServers()).toBe(true);
            client.off(ClientEvent.TurnServers, onTurnServers);
            expect(events).toEqual([
                [
                    [
                        {
                            urls: turnServer.uris,
                            username: turnServer.username,
                            credential: turnServer.password,
                        },
                    ],
                ],
            ]);
        });

        it("emits an event when an error occurs", async () => {
            const error = new Error(":(");
            jest.spyOn(client, "turnServer").mockRejectedValue(error);

            const events: any[][] = [];
            const onTurnServersError = (...args: any[]) => events.push(args);
            client.on(ClientEvent.TurnServersError, onTurnServersError);
            expect(await client.checkTurnServers()).toBe(false);
            client.off(ClientEvent.TurnServersError, onTurnServersError);
            expect(events).toEqual([[error, false]]); // non-fatal
        });

        it("considers 403 errors fatal", async () => {
            const error = { httpStatus: 403 };
            jest.spyOn(client, "turnServer").mockRejectedValue(error);

            const events: any[][] = [];
            const onTurnServersError = (...args: any[]) => events.push(args);
            client.on(ClientEvent.TurnServersError, onTurnServersError);
            expect(await client.checkTurnServers()).toBe(false);
            client.off(ClientEvent.TurnServersError, onTurnServersError);
            expect(events).toEqual([[error, true]]); // fatal
        });
    });

    describe("support for ignoring invites", () => {
        beforeEach(() => {
            // Mockup `getAccountData`/`setAccountData`.
            const dataStore = new Map();
            client.setAccountData = function (eventType, content) {
                dataStore.set(eventType, content);
                return Promise.resolve({});
            };
            client.getAccountData = function (eventType) {
                const data = dataStore.get(eventType);
                return new MatrixEvent({
                    content: data,
                });
            };

            // Mockup `createRoom`/`getRoom`/`joinRoom`, including state.
            const rooms = new Map();
            client.createRoom = function (options: Options = {}) {
                const roomId = options["_roomId"] || `!room-${rooms.size}:example.org`;
                const state = new Map<string, any>();
                const room = {
                    roomId,
                    _options: options,
                    _state: state,
                    getUnfilteredTimelineSet: function () {
                        return {
                            getLiveTimeline: function () {
                                return {
                                    getState: function (direction) {
                                        expect(direction).toBe(EventTimeline.FORWARDS);
                                        return {
                                            getStateEvents: function (type) {
                                                const store = state.get(type) || {};
                                                return Object.keys(store).map((key) => store[key]);
                                            },
                                        };
                                    },
                                } as EventTimeline;
                            },
                        };
                    },
                } as unknown as WrappedRoom;
                rooms.set(roomId, room);
                return Promise.resolve({ room_id: roomId });
            };
            client.getRoom = function (roomId) {
                return rooms.get(roomId);
            };
            client.joinRoom = async function (roomId) {
                return this.getRoom(roomId)! || this.createRoom({ _roomId: roomId } as ICreateRoomOpts);
            };

            // Mockup state events
            client.sendStateEvent = function (roomId, type, content) {
                const room = this.getRoom(roomId) as WrappedRoom;
                const state: Map<string, any> = room._state;
                let store = state.get(type);
                if (!store) {
                    store = {};
                    state.set(type, store);
                }
                const eventId = `$event-${Math.random()}:example.org`;
                store[eventId] = {
                    getId: function () {
                        return eventId;
                    },
                    getRoomId: function () {
                        return roomId;
                    },
                    getContent: function () {
                        return content;
                    },
                };
                return Promise.resolve({ event_id: eventId });
            };
            client.redactEvent = function (roomId, eventId) {
                const room = this.getRoom(roomId) as WrappedRoom;
                const state: Map<string, any> = room._state;
                for (const store of state.values()) {
                    delete store[eventId!];
                }
                return Promise.resolve({ event_id: "$" + eventId + "-" + Math.random() });
            };
        });

        it("should initialize and return the same `target` consistently", async () => {
            const target1 = await client.ignoredInvites.getOrCreateTargetRoom();
            const target2 = await client.ignoredInvites.getOrCreateTargetRoom();
            expect(target1).toBeTruthy();
            expect(target1).toBe(target2);
        });

        it("should initialize and return the same `sources` consistently", async () => {
            const sources1 = await client.ignoredInvites.getOrCreateSourceRooms();
            const sources2 = await client.ignoredInvites.getOrCreateSourceRooms();
            expect(sources1).toBeTruthy();
            expect(sources1).toHaveLength(1);
            expect(sources1).toEqual(sources2);
        });

        it("should initially not reject any invite", async () => {
            const rule = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(rule).toBeFalsy();
        });

        it("should reject invites once we have added a matching rule in the target room (scope: user)", async () => {
            await client.ignoredInvites.addRule(PolicyScope.User, "*:example.org", "just a test");

            // We should reject this invite.
            const ruleMatch = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleMatch).toBeTruthy();
            expect(ruleMatch!.getContent()).toMatchObject({
                recommendation: "m.ban",
                reason: "just a test",
            });

            // We should let these invites go through.
            const ruleWrongServer = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:somewhere.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleWrongServer).toBeFalsy();

            const ruleWrongServerRoom = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:somewhere.org",
                roomId: "!snafu:example.org",
            });
            expect(ruleWrongServerRoom).toBeFalsy();
        });

        it("should reject invites once we have added a matching rule in the target room (scope: server)", async () => {
            const REASON = `Just a test ${Math.random()}`;
            await client.ignoredInvites.addRule(PolicyScope.Server, "example.org", REASON);

            // We should reject these invites.
            const ruleSenderMatch = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleSenderMatch).toBeTruthy();
            expect(ruleSenderMatch!.getContent()).toMatchObject({
                recommendation: "m.ban",
                reason: REASON,
            });

            const ruleRoomMatch = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:somewhere.org",
                roomId: "!snafu:example.org",
            });
            expect(ruleRoomMatch).toBeTruthy();
            expect(ruleRoomMatch!.getContent()).toMatchObject({
                recommendation: "m.ban",
                reason: REASON,
            });

            // We should let these invites go through.
            const ruleWrongServer = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:somewhere.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleWrongServer).toBeFalsy();
        });

        it("should reject invites once we have added a matching rule in the target room (scope: room)", async () => {
            const REASON = `Just a test ${Math.random()}`;
            const BAD_ROOM_ID = "!bad:example.org";
            const GOOD_ROOM_ID = "!good:example.org";
            await client.ignoredInvites.addRule(PolicyScope.Room, BAD_ROOM_ID, REASON);

            // We should reject this invite.
            const ruleSenderMatch = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: BAD_ROOM_ID,
            });
            expect(ruleSenderMatch).toBeTruthy();
            expect(ruleSenderMatch!.getContent()).toMatchObject({
                recommendation: "m.ban",
                reason: REASON,
            });

            // We should let these invites go through.
            const ruleWrongRoom = await client.ignoredInvites.getRuleForInvite({
                sender: BAD_ROOM_ID,
                roomId: GOOD_ROOM_ID,
            });
            expect(ruleWrongRoom).toBeFalsy();
        });

        it("should reject invites once we have added a matching rule in a non-target source room", async () => {
            const NEW_SOURCE_ROOM_ID = "!another-source:example.org";

            // Make sure that everything is initialized.
            await client.ignoredInvites.getOrCreateSourceRooms();
            await client.joinRoom(NEW_SOURCE_ROOM_ID);
            await client.ignoredInvites.addSource(NEW_SOURCE_ROOM_ID);

            // Add a rule in the new source room.
            await client.sendStateEvent(NEW_SOURCE_ROOM_ID, EventType.PolicyRuleUser, {
                entity: "*:example.org",
                reason: "just a test",
                recommendation: PolicyRecommendation.Ban,
            });

            // We should reject this invite.
            const ruleMatch = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleMatch).toBeTruthy();
            expect(ruleMatch!.getContent()).toMatchObject({
                recommendation: "m.ban",
                reason: "just a test",
            });

            // We should let these invites go through.
            const ruleWrongServer = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:somewhere.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleWrongServer).toBeFalsy();

            const ruleWrongServerRoom = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:somewhere.org",
                roomId: "!snafu:example.org",
            });
            expect(ruleWrongServerRoom).toBeFalsy();
        });

        it("should not reject invites anymore once we have removed a rule", async () => {
            await client.ignoredInvites.addRule(PolicyScope.User, "*:example.org", "just a test");

            // We should reject this invite.
            const ruleMatch = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleMatch).toBeTruthy();
            expect(ruleMatch!.getContent()).toMatchObject({
                recommendation: "m.ban",
                reason: "just a test",
            });

            // After removing the invite, we shouldn't reject it anymore.
            await client.ignoredInvites.removeRule(ruleMatch as MatrixEvent);
            const ruleMatch2 = await client.ignoredInvites.getRuleForInvite({
                sender: "@foobar:example.org",
                roomId: "!snafu:somewhere.org",
            });
            expect(ruleMatch2).toBeFalsy();
        });

        it("should add new rules in the target room, rather than any other source room", async () => {
            const NEW_SOURCE_ROOM_ID = "!another-source:example.org";

            // Make sure that everything is initialized.
            await client.ignoredInvites.getOrCreateSourceRooms();
            await client.joinRoom(NEW_SOURCE_ROOM_ID);
            const newSourceRoom = client.getRoom(NEW_SOURCE_ROOM_ID) as WrappedRoom;

            // Fetch the list of sources and check that we do not have the new room yet.
            const policies = await client.getAccountData(POLICIES_ACCOUNT_EVENT_TYPE.name)!.getContent();
            expect(policies).toBeTruthy();
            const ignoreInvites = policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY.name];
            expect(ignoreInvites).toBeTruthy();
            expect(ignoreInvites.sources).toBeTruthy();
            expect(ignoreInvites.sources).not.toContain(NEW_SOURCE_ROOM_ID);

            // Add a source.
            const added = await client.ignoredInvites.addSource(NEW_SOURCE_ROOM_ID);
            expect(added).toBe(true);
            const added2 = await client.ignoredInvites.addSource(NEW_SOURCE_ROOM_ID);
            expect(added2).toBe(false);

            // Fetch the list of sources and check that we have added the new room.
            const policies2 = await client.getAccountData(POLICIES_ACCOUNT_EVENT_TYPE.name)!.getContent();
            expect(policies2).toBeTruthy();
            const ignoreInvites2 = policies2[IGNORE_INVITES_ACCOUNT_EVENT_KEY.name];
            expect(ignoreInvites2).toBeTruthy();
            expect(ignoreInvites2.sources).toBeTruthy();
            expect(ignoreInvites2.sources).toContain(NEW_SOURCE_ROOM_ID);

            // Add a rule.
            const eventId = await client.ignoredInvites.addRule(PolicyScope.User, "*:example.org", "just a test");

            // Check where it shows up.
            const targetRoomId = ignoreInvites2.target;
            const targetRoom = client.getRoom(targetRoomId) as WrappedRoom;
            expect(targetRoom._state.get(EventType.PolicyRuleUser)[eventId]).toBeTruthy();
            expect(newSourceRoom._state.get(EventType.PolicyRuleUser)?.[eventId]).toBeFalsy();
        });
    });

    describe("using E2EE in group calls", () => {
        const opts = {
            baseUrl: "https://my.home.server",
            idBaseUrl: identityServerUrl,
            accessToken: "my.access.token",
            store: store,
            scheduler: scheduler,
            userId: userId,
        };

        it("enables E2EE by default", () => {
            const client = new MatrixClient(opts);

            expect(client.getUseE2eForGroupCall()).toBe(true);
        });

        it("enables E2EE when enabled explicitly", () => {
            const client = new MatrixClient({
                useE2eForGroupCall: true,
                ...opts,
            });

            expect(client.getUseE2eForGroupCall()).toBe(true);
        });

        it("disables E2EE if disabled explicitly", () => {
            const client = new MatrixClient({
                useE2eForGroupCall: false,
                ...opts,
            });

            expect(client.getUseE2eForGroupCall()).toBe(false);
        });
    });

    describe("setAccountData", () => {
        const TEST_HOMESERVER_URL = "https://alice-server.com";

        /** Create and start a MatrixClient, connected to the `TEST_HOMESERVER_URL` */
        async function setUpClient(): Promise<MatrixClient> {
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);
            fetchMock.config.warnOnFallback = false;

            mockInitialApiRequests(TEST_HOMESERVER_URL, userId);

            const client = createClient({ baseUrl: TEST_HOMESERVER_URL, userId });
            await client.startClient();

            // Remember to stop the client again, to stop it spamming logs and HTTP requests
            afterTestHooks.push(() => client.stopClient());
            return client;
        }

        it("falls back to raw request if called before the client is started", async () => {
            // GIVEN a bunch of setup
            const client = createClient({ baseUrl: TEST_HOMESERVER_URL, userId });

            const eventType = "im.vector.test";
            const content = { a: 1 };
            const testresponse = { test: 1 };

            // ... including an expected REST request
            const url = new URL(
                `/_matrix/client/v3/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${eventType}`,
                TEST_HOMESERVER_URL,
            ).toString();
            fetchMock.put({ url, name: "put-account-data" }, testresponse);

            // suppress the expected warning on the console
            jest.spyOn(console, "warn").mockImplementation();

            // WHEN we call `setAccountData` ...
            const result = await client.setAccountData(eventType, content);

            // THEN, method should have returned the right thing
            expect(result).toEqual(testresponse);

            // and the REST call should have happened, and had the correct content
            const lastCall = fetchMock.lastCall("put-account-data");
            expect(lastCall).toBeDefined();
            expect(lastCall?.[1]?.body).toEqual(JSON.stringify(content));

            // and a warning should have been logged
            // eslint-disable-next-line no-console
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining("Calling `setAccountData` before the client is started"),
            );
        });

        it("makes a request to the server, and waits for the /sync response", async () => {
            // GIVEN a bunch of setup
            const syncResponder = new SyncResponder(TEST_HOMESERVER_URL);
            const client = await setUpClient();

            const eventType = "im.vector.test";
            const content = { a: 1 };
            const testresponse = { test: 1 };

            // ... including an expected REST request
            const url = new URL(
                `/_matrix/client/v3/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${eventType}`,
                TEST_HOMESERVER_URL,
            ).toString();
            fetchMock.put({ url, name: "put-account-data" }, testresponse);

            // WHEN we call `setAccountData` ...
            const setProm = client.setAccountData(eventType, content);

            await jest.advanceTimersByTimeAsync(10);
            // THEN, the REST call should have happened, and had the correct content
            const lastCall = fetchMock.lastCall("put-account-data");
            expect(lastCall).toBeDefined();
            expect(lastCall?.[1]?.body).toEqual(JSON.stringify(content));

            // Even after waiting a bit more, the method should not yet have returned
            await jest.advanceTimersByTimeAsync(10);
            let finished = false;
            setProm.finally(() => (finished = true));
            expect(finished).toBeFalsy();

            // ... and `getAccountData` still returns the wrong thing
            expect(client.getAccountData(eventType)).not.toBeDefined();

            // WHEN the update arrives over /sync
            const content2 = { a: 2 };

            syncResponder.sendOrQueueSyncResponse({
                account_data: { events: [{ type: eventType, content: content2 }] },
            });

            // THEN the method should complete, and `getAccountData` returns the new data
            expect(await setProm).toEqual(testresponse);
            expect(client.getAccountData(eventType)?.event).toEqual({ type: eventType, content: content2 });
        });

        it("does nothing if the data matches what is there", async () => {
            // GIVEN a running matrix client ...
            const syncResponder = new SyncResponder(TEST_HOMESERVER_URL);
            const client = await setUpClient();

            // ... which has previously received the account data over /sync
            const eventType = "im.vector.test";
            const content = { a: 1, b: 2 };

            // Keys in a different order, to check that doesn't matter.
            const syncedContent = { b: 2, a: 1 };
            syncResponder.sendOrQueueSyncResponse({
                account_data: { events: [{ type: eventType, content: syncedContent }] },
            });
            await jest.advanceTimersByTimeAsync(1);

            // Check that getAccountData is ready
            expect(client.getAccountData(eventType)?.event).toEqual({ type: eventType, content: syncedContent });

            // WHEN we call `setAccountData` ...
            await client.setAccountData(eventType, content);

            // THEN there should be no REST call
            expect(fetchMock.calls(/account_data/).length).toEqual(0);
        });
    });

    describe("delete account data", () => {
        const TEST_HOMESERVER_URL = "https://alice-server.com";

        /** Create and start a MatrixClient, connected to the `TEST_HOMESERVER_URL` */
        async function setUpClient(versionsResponse: object = { versions: ["1"] }): Promise<MatrixClient> {
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);
            fetchMock.config.warnOnFallback = false;

            fetchMock.getOnce(new URL("/_matrix/client/versions", TEST_HOMESERVER_URL).toString(), versionsResponse, {
                overwriteRoutes: true,
            });
            fetchMock.getOnce(
                new URL("/_matrix/client/v3/pushrules/", TEST_HOMESERVER_URL).toString(),
                {},
                { overwriteRoutes: true },
            );
            fetchMock.postOnce(
                new URL(`/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`, TEST_HOMESERVER_URL).toString(),
                { filter_id: "fid" },
                { overwriteRoutes: true },
            );

            const client = createClient({ baseUrl: TEST_HOMESERVER_URL, userId });
            await client.startClient();

            // Remember to stop the client again, to stop it spamming logs and HTTP requests
            afterTestHooks.push(() => client.stopClient());
            return client;
        }

        it("makes correct request when deletion is supported by server in unstable versions", async () => {
            const eventType = "im.vector.test";
            const versionsResponse = {
                versions: ["1"],
                unstable_features: {
                    "org.matrix.msc3391": true,
                },
            };
            const client = await setUpClient(versionsResponse);

            const url = new URL(
                `/_matrix/client/unstable/org.matrix.msc3391/user/${encodeURIComponent(userId)}/account_data/${eventType}`,
                TEST_HOMESERVER_URL,
            ).toString();
            fetchMock.delete({ url, name: "delete-data" }, {});

            await client.deleteAccountData(eventType);

            expect(fetchMock.calls("delete-data").length).toEqual(1);
        });

        it("makes correct request when deletion is supported by server based on matrix version", async () => {
            const eventType = "im.vector.test";
            // we don't have a stable version for account data deletion yet to test this code path with
            // so mock the support map to fake stable support
            const stableSupportedDeletionMap = new Map();
            stableSupportedDeletionMap.set(featureUtils.Feature.AccountDataDeletion, featureUtils.ServerSupport.Stable);
            jest.spyOn(featureUtils, "buildFeatureSupportMap").mockResolvedValue(stableSupportedDeletionMap);

            const client = await setUpClient();

            const url = new URL(
                `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${eventType}`,
                TEST_HOMESERVER_URL,
            ).toString();
            fetchMock.delete({ url, name: "delete-data" }, {});

            await client.deleteAccountData(eventType);

            expect(fetchMock.calls("delete-data").length).toEqual(1);
        });

        it("makes correct request when deletion is not supported by server", async () => {
            const eventType = "im.vector.test";

            const syncResponder = new SyncResponder(TEST_HOMESERVER_URL);
            const client = await setUpClient();

            const url = new URL(
                `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${eventType}`,
                TEST_HOMESERVER_URL,
            ).toString();
            fetchMock.put({ url, name: "put-account-data" }, {});

            const setProm = client.deleteAccountData(eventType);
            syncResponder.sendOrQueueSyncResponse({
                account_data: { events: [{ type: eventType, content: {} }] },
            });
            await setProm;

            // account data updated with empty content
            const lastCall = fetchMock.lastCall("put-account-data");
            expect(lastCall).toBeDefined();
            expect(lastCall?.[1]?.body).toEqual("{}");
        });
    });

    describe("room lists and history", () => {
        function roomCreateEvent(newRoomId: string, predecessorRoomId: string): MatrixEvent {
            return new MatrixEvent({
                content: {
                    "m.federate": true,
                    "predecessor": {
                        event_id: "id_of_last_event",
                        room_id: predecessorRoomId,
                    },
                    "room_version": "9",
                },
                event_id: `create_event_id_pred_${predecessorRoomId}`,
                origin_server_ts: 1432735824653,
                room_id: newRoomId,
                sender: "@daryl:alexandria.example.com",
                state_key: "",
                type: "m.room.create",
            });
        }

        function tombstoneEvent(newRoomId: string, predecessorRoomId: string): MatrixEvent {
            return new MatrixEvent({
                content: {
                    body: "This room has been replaced",
                    replacement_room: newRoomId,
                },
                event_id: `tombstone_event_id_pred_${predecessorRoomId}`,
                origin_server_ts: 1432735824653,
                room_id: predecessorRoomId,
                sender: "@daryl:alexandria.example.com",
                state_key: "",
                type: "m.room.tombstone",
            });
        }

        function predecessorEvent(newRoomId: string, predecessorRoomId: string): MatrixEvent {
            return new MatrixEvent({
                content: {
                    predecessor_room_id: predecessorRoomId,
                },
                event_id: `predecessor_event_id_pred_${predecessorRoomId}`,
                origin_server_ts: 1432735824653,
                room_id: newRoomId,
                sender: "@daryl:alexandria.example.com",
                state_key: "",
                type: "org.matrix.msc3946.room_predecessor",
            });
        }

        describe("getVisibleRooms", () => {
            function setUpReplacedRooms(): {
                room1: Room;
                room2: Room;
                replacedByCreate1: Room;
                replacedByCreate2: Room;
                replacedByDynamicPredecessor1: Room;
                replacedByDynamicPredecessor2: Room;
            } {
                const room1 = new Room("room1", client, "@carol:alexandria.example.com");
                const replacedByCreate1 = new Room("replacedByCreate1", client, "@carol:alexandria.example.com");
                const replacedByCreate2 = new Room("replacedByCreate2", client, "@carol:alexandria.example.com");
                const replacedByDynamicPredecessor1 = new Room("dyn1", client, "@carol:alexandria.example.com");
                const replacedByDynamicPredecessor2 = new Room("dyn2", client, "@carol:alexandria.example.com");
                const room2 = new Room("room2", client, "@daryl:alexandria.example.com");
                client.store = new StubStore();
                client.store.getRooms = () => [
                    room1,
                    replacedByCreate1,
                    replacedByCreate2,
                    replacedByDynamicPredecessor1,
                    replacedByDynamicPredecessor2,
                    room2,
                ];
                room1.addLiveEvents(
                    [
                        roomCreateEvent(room1.roomId, replacedByCreate1.roomId),
                        predecessorEvent(room1.roomId, replacedByDynamicPredecessor1.roomId),
                    ],
                    { addToState: true },
                );
                room2.addLiveEvents(
                    [
                        roomCreateEvent(room2.roomId, replacedByCreate2.roomId),
                        predecessorEvent(room2.roomId, replacedByDynamicPredecessor2.roomId),
                    ],
                    { addToState: true },
                );
                replacedByCreate1.addLiveEvents([tombstoneEvent(room1.roomId, replacedByCreate1.roomId)], {
                    addToState: true,
                });
                replacedByCreate2.addLiveEvents([tombstoneEvent(room2.roomId, replacedByCreate2.roomId)], {
                    addToState: true,
                });
                replacedByDynamicPredecessor1.addLiveEvents(
                    [tombstoneEvent(room1.roomId, replacedByDynamicPredecessor1.roomId)],
                    { addToState: true },
                );
                replacedByDynamicPredecessor2.addLiveEvents(
                    [tombstoneEvent(room2.roomId, replacedByDynamicPredecessor2.roomId)],
                    { addToState: true },
                );

                return {
                    room1,
                    room2,
                    replacedByCreate1,
                    replacedByCreate2,
                    replacedByDynamicPredecessor1,
                    replacedByDynamicPredecessor2,
                };
            }
            it("Returns an empty list if there are no rooms", () => {
                client.store = new StubStore();
                client.store.getRooms = () => [];
                const rooms = client.getVisibleRooms();
                expect(rooms).toHaveLength(0);
            });

            it("Returns all non-replaced rooms", () => {
                const room1 = new Room("room1", client, "@carol:alexandria.example.com");
                const room2 = new Room("room2", client, "@daryl:alexandria.example.com");
                client.store = new StubStore();
                client.store.getRooms = () => [room1, room2];
                const rooms = client.getVisibleRooms();
                expect(rooms).toContain(room1);
                expect(rooms).toContain(room2);
                expect(rooms).toHaveLength(2);
            });

            it("Does not return replaced rooms", () => {
                // Given 4 rooms, 2 of which have been replaced
                const room1 = new Room("room1", client, "@carol:alexandria.example.com");
                const replacedRoom1 = new Room("replacedRoom1", client, "@carol:alexandria.example.com");
                const replacedRoom2 = new Room("replacedRoom2", client, "@carol:alexandria.example.com");
                const room2 = new Room("room2", client, "@daryl:alexandria.example.com");
                client.store = new StubStore();
                client.store.getRooms = () => [room1, replacedRoom1, replacedRoom2, room2];
                room1.addLiveEvents([roomCreateEvent(room1.roomId, replacedRoom1.roomId)], { addToState: true });
                room2.addLiveEvents([roomCreateEvent(room2.roomId, replacedRoom2.roomId)], { addToState: true });
                replacedRoom1.addLiveEvents([tombstoneEvent(room1.roomId, replacedRoom1.roomId)], { addToState: true });
                replacedRoom2.addLiveEvents([tombstoneEvent(room2.roomId, replacedRoom2.roomId)], { addToState: true });

                // When we ask for the visible rooms
                const rooms = client.getVisibleRooms();

                // Then we only get the ones that have not been replaced
                expect(rooms).not.toContain(replacedRoom1);
                expect(rooms).not.toContain(replacedRoom2);
                expect(rooms).toContain(room1);
                expect(rooms).toContain(room2);
            });

            it("Ignores m.predecessor if we don't ask to use it", () => {
                // Given 6 rooms, 2 of which have been replaced, and 2 of which WERE
                // replaced by create events, but are now NOT replaced, because an
                // m.predecessor event has changed the room's predecessor.
                const {
                    room1,
                    room2,
                    replacedByCreate1,
                    replacedByCreate2,
                    replacedByDynamicPredecessor1,
                    replacedByDynamicPredecessor2,
                } = setUpReplacedRooms();

                // When we ask for the visible rooms
                const rooms = client.getVisibleRooms(); // Don't supply msc3946ProcessDynamicPredecessor

                // Then we only get the ones that have not been replaced
                expect(rooms).not.toContain(replacedByCreate1);
                expect(rooms).not.toContain(replacedByCreate2);
                expect(rooms).toContain(replacedByDynamicPredecessor1);
                expect(rooms).toContain(replacedByDynamicPredecessor2);
                expect(rooms).toContain(room1);
                expect(rooms).toContain(room2);
            });

            it("Considers rooms replaced with m.predecessor events to be replaced", () => {
                // Given 6 rooms, 2 of which have been replaced, and 2 of which WERE
                // replaced by create events, but are now NOT replaced, because an
                // m.predecessor event has changed the room's predecessor.
                const {
                    room1,
                    room2,
                    replacedByCreate1,
                    replacedByCreate2,
                    replacedByDynamicPredecessor1,
                    replacedByDynamicPredecessor2,
                } = setUpReplacedRooms();

                // When we ask for the visible rooms
                const useMsc3946 = true;
                const rooms = client.getVisibleRooms(useMsc3946);

                // Then we only get the ones that have not been replaced
                expect(rooms).not.toContain(replacedByDynamicPredecessor1);
                expect(rooms).not.toContain(replacedByDynamicPredecessor2);
                expect(rooms).toContain(replacedByCreate1);
                expect(rooms).toContain(replacedByCreate2);
                expect(rooms).toContain(room1);
                expect(rooms).toContain(room2);
            });
        });

        describe("getRoomUpgradeHistory", () => {
            /**
             * Create a chain of room history with create events and tombstones.
             *
             * @param creates include create events (default=true)
             * @param tombstones include tomstone events (default=true)
             * @returns 4 rooms chained together with tombstones and create
             *          events, in order from oldest to latest.
             */
            function createRoomHistory(creates = true, tombstones = true): [Room, Room, Room, Room] {
                const room1 = new Room("room1", client, "@carol:alexandria.example.com");
                const room2 = new Room("room2", client, "@daryl:alexandria.example.com");
                const room3 = new Room("room3", client, "@rick:helicopter.example.com");
                const room4 = new Room("room4", client, "@michonne:hawthorne.example.com");

                if (creates) {
                    room2.addLiveEvents([roomCreateEvent(room2.roomId, room1.roomId)], { addToState: true });
                    room3.addLiveEvents([roomCreateEvent(room3.roomId, room2.roomId)], { addToState: true });
                    room4.addLiveEvents([roomCreateEvent(room4.roomId, room3.roomId)], { addToState: true });
                }

                if (tombstones) {
                    room1.addLiveEvents([tombstoneEvent(room2.roomId, room1.roomId)], { addToState: true });
                    room2.addLiveEvents([tombstoneEvent(room3.roomId, room2.roomId)], { addToState: true });
                    room3.addLiveEvents([tombstoneEvent(room4.roomId, room3.roomId)], { addToState: true });
                }

                mocked(store.getRoom).mockImplementation((roomId: string) => {
                    return { room1, room2, room3, room4 }[roomId] || null;
                });

                return [room1, room2, room3, room4];
            }

            /**
             * Creates 2 alternate chains of room history: one using create
             * events, and one using MSC2946 predecessor+tombstone events.
             *
             * Using create, history looks like:
             * room1->room2->room3->room4 (but note we do not create tombstones)
             *
             * Using predecessor+tombstone, history looks like:
             * dynRoom1->dynRoom2->room3->dynRoom4->dynRoom4
             *
             * @returns [room1, room2, room3, room4, dynRoom1, dynRoom2,
             *          dynRoom4, dynRoom5].
             */
            function createDynamicRoomHistory(): [Room, Room, Room, Room, Room, Room, Room, Room] {
                // Don't create tombstones for the old versions - we generally
                // expect only one tombstone in a room, and we are confused by
                // anything else.
                const creates = true;
                const tombstones = false;
                const [room1, room2, room3, room4] = createRoomHistory(creates, tombstones);
                const dynRoom1 = new Room("dynRoom1", client, "@rick:grimes.example.com");
                const dynRoom2 = new Room("dynRoom2", client, "@rick:grimes.example.com");
                const dynRoom4 = new Room("dynRoom4", client, "@rick:grimes.example.com");
                const dynRoom5 = new Room("dynRoom5", client, "@rick:grimes.example.com");

                dynRoom1.addLiveEvents([tombstoneEvent(dynRoom2.roomId, dynRoom1.roomId)], { addToState: true });
                dynRoom2.addLiveEvents([predecessorEvent(dynRoom2.roomId, dynRoom1.roomId)], { addToState: true });

                dynRoom2.addLiveEvents([tombstoneEvent(room3.roomId, dynRoom2.roomId)], { addToState: true });
                room3.addLiveEvents([predecessorEvent(room3.roomId, dynRoom2.roomId)], { addToState: true });

                room3.addLiveEvents([tombstoneEvent(dynRoom4.roomId, room3.roomId)], { addToState: true });
                dynRoom4.addLiveEvents([predecessorEvent(dynRoom4.roomId, room3.roomId)], { addToState: true });

                dynRoom4.addLiveEvents([tombstoneEvent(dynRoom5.roomId, dynRoom4.roomId)], { addToState: true });
                dynRoom5.addLiveEvents([predecessorEvent(dynRoom5.roomId, dynRoom4.roomId)], { addToState: true });

                mocked(store.getRoom)
                    .mockClear()
                    .mockImplementation((roomId: string) => {
                        return { room1, room2, room3, room4, dynRoom1, dynRoom2, dynRoom4, dynRoom5 }[roomId] || null;
                    });

                return [room1, room2, room3, room4, dynRoom1, dynRoom2, dynRoom4, dynRoom5];
            }

            it("Returns an empty list if room does not exist", () => {
                const history = client.getRoomUpgradeHistory("roomthatdoesnotexist");
                expect(history).toHaveLength(0);
            });

            it("Returns just this room if there is no predecessor", () => {
                const mainRoom = new Room("mainRoom", client, "@carol:alexandria.example.com");
                mocked(store.getRoom).mockReturnValue(mainRoom);
                const history = client.getRoomUpgradeHistory(mainRoom.roomId);
                expect(history).toEqual([mainRoom]);
            });

            it("Returns the predecessors of this room", () => {
                const [room1, room2, room3, room4] = createRoomHistory();
                const history = client.getRoomUpgradeHistory(room4.roomId);
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("Returns the predecessors of this room (with verify links)", () => {
                const [room1, room2, room3, room4] = createRoomHistory();
                const verifyLinks = true;
                const history = client.getRoomUpgradeHistory(room4.roomId, verifyLinks);
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("With verify links, rejects predecessors that don't point forwards", () => {
                // Given successors point back with create events, but
                // predecessors do not point forwards with tombstones
                const [, , , room4] = createRoomHistory(true, false);

                // When I ask for history with verifyLinks on
                const verifyLinks = true;
                const history = client.getRoomUpgradeHistory(room4.roomId, verifyLinks);

                // Then the predecessors are not included in the history
                expect(history.map((room) => room.roomId)).toEqual([room4.roomId]);
            });

            it("Without verify links, includes predecessors that don't point forwards", () => {
                // Given successors point back with create events, but
                // predecessors do not point forwards with tombstones
                const [room1, room2, room3, room4] = createRoomHistory(true, false);

                // When I ask for history with verifyLinks off
                const verifyLinks = false;
                const history = client.getRoomUpgradeHistory(room4.roomId, verifyLinks);

                // Then the predecessors are included in the history
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("Returns the subsequent rooms", () => {
                const [room1, room2, room3, room4] = createRoomHistory();
                const history = client.getRoomUpgradeHistory(room1.roomId);
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("Returns the subsequent rooms (with verify links)", () => {
                const [room1, room2, room3, room4] = createRoomHistory();
                const verifyLinks = true;
                const history = client.getRoomUpgradeHistory(room1.roomId, verifyLinks);
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("With verify links, rejects successors that don't point backwards", () => {
                // Given predecessors point forwards with tombstones, but
                // successors do not point back with create events.
                const [room1, , ,] = createRoomHistory(false, true);

                // When I ask for history with verifyLinks on
                const verifyLinks = true;
                const history = client.getRoomUpgradeHistory(room1.roomId, verifyLinks);

                // Then the successors are not included in the history
                expect(history.map((room) => room.roomId)).toEqual([room1.roomId]);
            });

            it("Without verify links, includes successors that don't point backwards", () => {
                // Given predecessors point forwards with tombstones, but
                // successors do not point back with create events.
                const [room1, room2, room3, room4] = createRoomHistory(false, true);

                // When I ask for history with verifyLinks off
                const verifyLinks = false;
                const history = client.getRoomUpgradeHistory(room1.roomId, verifyLinks);

                // Then the successors are included in the history
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("Returns the predecessors and subsequent rooms", () => {
                const [room1, room2, room3, room4] = createRoomHistory();
                const history = client.getRoomUpgradeHistory(room3.roomId);
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("Returns the predecessors and subsequent rooms (with verify links)", () => {
                const [room1, room2, room3, room4] = createRoomHistory();
                const verifyLinks = true;
                const history = client.getRoomUpgradeHistory(room3.roomId, verifyLinks);
                expect(history.map((room) => room.roomId)).toEqual([
                    room1.roomId,
                    room2.roomId,
                    room3.roomId,
                    room4.roomId,
                ]);
            });

            it("Returns the predecessors and subsequent rooms using MSC3945 dynamic room predecessors", () => {
                const [, , room3, , dynRoom1, dynRoom2, dynRoom4, dynRoom5] = createDynamicRoomHistory();
                const useMsc3946 = true;
                const verifyLinks = false;
                const history = client.getRoomUpgradeHistory(room3.roomId, verifyLinks, useMsc3946);
                expect(history.map((room) => room.roomId)).toEqual([
                    dynRoom1.roomId,
                    dynRoom2.roomId,
                    room3.roomId,
                    dynRoom4.roomId,
                    dynRoom5.roomId,
                ]);
            });

            it("When not asking for MSC3946, verified history without tombstones is empty", () => {
                // There no tombstones to match the create events
                const [, , room3] = createDynamicRoomHistory();
                const useMsc3946 = false;
                const verifyLinks = true;
                const history = client.getRoomUpgradeHistory(room3.roomId, verifyLinks, useMsc3946);
                // So we get no history back
                expect(history.map((room) => room.roomId)).toEqual([room3.roomId]);
            });
        });
    });

    // these wrappers are deprecated, but we need coverage of them to pass the quality gate
    describe("SecretStorage wrappers", () => {
        let mockSecretStorage: Mocked<ServerSideSecretStorageImpl>;

        beforeEach(() => {
            mockSecretStorage = {
                getDefaultKeyId: jest.fn(),
                hasKey: jest.fn(),
                isStored: jest.fn(),
            } as unknown as Mocked<ServerSideSecretStorageImpl>;
            client["_secretStorage"] = mockSecretStorage;
        });

        it("isKeyBackupKeyStored", async () => {
            mockSecretStorage.isStored.mockResolvedValue(null);
            expect(await client.isKeyBackupKeyStored()).toBe(null);
            expect(mockSecretStorage.isStored).toHaveBeenCalledWith("m.megolm_backup.v1");
        });
    });

    describe("paginateEventTimeline()", () => {
        describe("notifications timeline", () => {
            const unsafeNotification = {
                actions: ["notify"],
                room_id: "__proto__",
                event: testUtils.mkMessage({
                    user: "@villain:server.org",
                    room: "!roomId:server.org",
                    msg: "I am nefarious",
                }),
                profile_tag: null,
                read: true,
                ts: 12345,
            };

            const goodNotification = {
                actions: ["notify"],
                room_id: "!favouriteRoom:server.org",
                event: new MatrixEvent({
                    sender: "@bob:server.org",
                    room_id: "!roomId:server.org",
                    type: "m.call.invite",
                    content: {},
                }),
                profile_tag: null,
                read: true,
                ts: 12345,
            };

            const highlightNotification = {
                actions: ["notify", { set_tweak: "highlight", value: true }],
                room_id: "!roomId:server.org",
                event: testUtils.mkMessage({
                    user: "@bob:server.org",
                    room: "!roomId:server.org",
                    msg: "I am highlighted banana",
                }),
                profile_tag: null,
                read: true,
                ts: 12345,
            };

            const setNotifsResponse = (notifications: any[] = []): void => {
                const response: HttpLookup = {
                    method: "GET",
                    path: "/notifications",
                    data: { notifications: JSON.parse(JSON.stringify(notifications)) },
                };
                httpLookups = [response];
            };

            const callRule: IPushRule = {
                actions: [PushRuleActionName.Notify],
                conditions: [
                    {
                        kind: ConditionKind.EventMatch,
                        key: "type",
                        pattern: "m.call.invite",
                    },
                ],
                default: true,
                enabled: true,
                rule_id: ".m.rule.call",
            };
            const masterRule: IPushRule = {
                actions: [PushRuleActionName.DontNotify],
                conditions: [],
                default: true,
                enabled: false,
                rule_id: RuleId.Master,
            };
            const bananaRule = {
                actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Highlight, value: true }],
                pattern: "banana",
                rule_id: "banana",
                default: false,
                enabled: true,
            } as IPushRule;
            const pushRules = {
                global: {
                    underride: [callRule],
                    override: [masterRule],
                    content: [bananaRule],
                },
            };

            beforeEach(() => {
                makeClient();

                // this is how notif timeline is set up in react-sdk
                const notifTimelineSet = new EventTimelineSet(undefined, {
                    timelineSupport: true,
                    pendingEvents: false,
                });
                notifTimelineSet.getLiveTimeline().setPaginationToken("", EventTimeline.BACKWARDS);
                client.setNotifTimelineSet(notifTimelineSet);

                setNotifsResponse();

                client.setPushRules(pushRules);
            });

            it("should throw when trying to paginate forwards", async () => {
                const timeline = client.getNotifTimelineSet()!.getLiveTimeline();
                await expect(
                    async () => await client.paginateEventTimeline(timeline, { backwards: false }),
                ).rejects.toThrow("paginateNotifTimeline can only paginate backwards");
            });

            it("defaults limit to 30 events", async () => {
                jest.spyOn(client.http, "authedRequest");
                const timeline = client.getNotifTimelineSet()!.getLiveTimeline();
                await client.paginateEventTimeline(timeline, { backwards: true });

                expect(client.http.authedRequest).toHaveBeenCalledWith(Method.Get, "/notifications", {
                    limit: "30",
                    only: "highlight",
                });
            });

            it("filters out unsafe notifications", async () => {
                setNotifsResponse([unsafeNotification, goodNotification, highlightNotification]);

                const timelineSet = client.getNotifTimelineSet()!;
                const timeline = timelineSet.getLiveTimeline();
                await client.paginateEventTimeline(timeline, { backwards: true });

                // badNotification not added to timeline
                const timelineEvents = timeline.getEvents();
                expect(timelineEvents.length).toEqual(2);
            });

            it("sets push details on events and add to timeline", async () => {
                setNotifsResponse([goodNotification, highlightNotification]);

                const timelineSet = client.getNotifTimelineSet()!;
                const timeline = timelineSet.getLiveTimeline();
                await client.paginateEventTimeline(timeline, { backwards: true });

                const [highlightEvent, goodEvent] = timeline.getEvents();
                expect(highlightEvent.getPushActions()).toEqual({
                    notify: true,
                    tweaks: {
                        highlight: true,
                    },
                });
                expect(highlightEvent.getPushDetails().rule).toEqual({
                    ...bananaRule,
                    kind: "content",
                });
                expect(goodEvent.getPushActions()).toEqual({
                    notify: true,
                    tweaks: {
                        highlight: false,
                    },
                });
            });
        });
    });

    describe("pushers", () => {
        const pusher = {
            app_id: "test",
            app_display_name: "Test App",
            data: {},
            device_display_name: "test device",
            kind: "http",
            lang: "en-NZ",
            pushkey: "1234",
        };

        beforeEach(() => {
            makeClient();
            const response: HttpLookup = {
                method: Method.Post,
                path: "/pushers/set",
                data: {},
            };
            httpLookups = [response];
            jest.spyOn(client.http, "authedRequest").mockClear();
        });

        it("should make correct request to set pusher", async () => {
            const result = await client.setPusher(pusher);
            expect(client.http.authedRequest).toHaveBeenCalledWith(Method.Post, "/pushers/set", undefined, pusher);
            expect(result).toEqual({});
        });

        it("should make correct request to remove pusher", async () => {
            const result = await client.removePusher(pusher.pushkey, pusher.app_id);
            expect(client.http.authedRequest).toHaveBeenCalledWith(Method.Post, "/pushers/set", undefined, {
                pushkey: pusher.pushkey,
                app_id: pusher.app_id,
                kind: null,
            });
            expect(result).toEqual({});
        });
    });

    describe("getAuthIssuer", () => {
        it("should use unstable prefix", async () => {
            httpLookups = [
                {
                    method: "GET",
                    path: `/auth_issuer`,
                    data: {
                        issuer: "https://issuer/",
                    },
                    prefix: "/_matrix/client/unstable/org.matrix.msc2965",
                },
            ];

            await expect(client.getAuthIssuer()).resolves.toEqual({ issuer: "https://issuer/" });
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("getAuthMetadata", () => {
        beforeEach(() => {
            fetchMock.mockReset();
            // This request is made by oidc-client-ts so is not intercepted by httpLookups
            fetchMock.get("https://auth.org/jwks", {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
                keys: [],
            });
        });

        it("should use unstable prefix", async () => {
            const metadata = mockOpenIdConfiguration();
            httpLookups = [
                {
                    method: "GET",
                    path: `/auth_metadata`,
                    data: metadata,
                    prefix: "/_matrix/client/unstable/org.matrix.msc2965",
                },
            ];

            await expect(client.getAuthMetadata()).resolves.toEqual({
                ...metadata,
                signingKeys: [],
            });
            expect(httpLookups.length).toEqual(0);
        });

        it("should fall back to auth_issuer + openid-configuration", async () => {
            const metadata = mockOpenIdConfiguration();
            httpLookups = [
                {
                    method: "GET",
                    path: `/auth_metadata`,
                    error: new MatrixError({ errcode: "M_UNRECOGNIZED" }, 404),
                    prefix: "/_matrix/client/unstable/org.matrix.msc2965",
                },
                {
                    method: "GET",
                    path: `/auth_issuer`,
                    data: { issuer: metadata.issuer },
                    prefix: "/_matrix/client/unstable/org.matrix.msc2965",
                },
            ];
            fetchMock.get("https://auth.org/.well-known/openid-configuration", metadata);

            await expect(client.getAuthMetadata()).resolves.toEqual({
                ...metadata,
                signingKeys: [],
            });
            expect(httpLookups.length).toEqual(0);
        });
    });

    describe("identityHashedLookup", () => {
        it("should return hashed lookup results", async () => {
            const ID_ACCESS_TOKEN = "hello_id_server_please_let_me_make_a_request";

            client.http.idServerRequest = jest.fn().mockImplementation((method, path, params) => {
                if (method === "GET" && path === "/hash_details") {
                    return { algorithms: ["sha256"], lookup_pepper: "carrot" };
                } else if (method === "POST" && path === "/lookup") {
                    return {
                        mappings: {
                            "WHA-MgrrsZACDI9F8OaVagpiyiV2sjZylGHJteT4OMU": "@bob:homeserver.dummy",
                        },
                    };
                }

                throw new Error("Test impl doesn't know about this request");
            });

            const lookupResult = await client.identityHashedLookup([["bob@email.dummy", "email"]], ID_ACCESS_TOKEN);

            expect(client.http.idServerRequest).toHaveBeenCalledWith(
                "GET",
                "/hash_details",
                undefined,
                "/_matrix/identity/v2",
                ID_ACCESS_TOKEN,
            );

            expect(client.http.idServerRequest).toHaveBeenCalledWith(
                "POST",
                "/lookup",
                { pepper: "carrot", algorithm: "sha256", addresses: ["WHA-MgrrsZACDI9F8OaVagpiyiV2sjZylGHJteT4OMU"] },
                "/_matrix/identity/v2",
                ID_ACCESS_TOKEN,
            );

            expect(lookupResult).toHaveLength(1);
            expect(lookupResult[0]).toEqual({ address: "bob@email.dummy", mxid: "@bob:homeserver.dummy" });
        });
    });
});
