/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

export enum Visibility {
    Public = "public",
    Private = "private",
}

export enum Preset {
    PrivateChat = "private_chat",
    TrustedPrivateChat = "trusted_private_chat",
    PublicChat = "public_chat",
}

export type ResizeMethod = "crop" | "scale";

export type IdServerUnbindResult = "no-support" | "success";

// Knock and private are reserved keywords which are not yet implemented.
export enum JoinRule {
    Public = "public",
    Invite = "invite",
    /**
     * @deprecated Reserved keyword. Should not be used. Not yet implemented.
     */
    Private = "private",
    Knock = "knock",
    Restricted = "restricted",
}

export enum RestrictedAllowType {
    RoomMembership = "m.room_membership",
}

export enum GuestAccess {
    CanJoin = "can_join",
    Forbidden = "forbidden",
}

export enum HistoryVisibility {
    Invited = "invited",
    Joined = "joined",
    Shared = "shared",
    WorldReadable = "world_readable",
}

export interface IUsageLimit {
    // "hs_disabled" is NOT a specced string, but is used in Synapse
    // This is tracked over at https://github.com/matrix-org/synapse/issues/9237
    // eslint-disable-next-line camelcase
    limit_type: "monthly_active_user" | "hs_disabled" | string;
    // eslint-disable-next-line camelcase
    admin_contact?: string;
}

/**
 * A policy name & url in a specific internationalisation
 * @see https://spec.matrix.org/v1.13/identity-service-api/#get_matrixidentityv2terms_response-200_internationalised-policy
 */
export interface InternationalisedPolicy {
    name: string;
    url: string;
}

/**
 * A versioned policy with internationalised variants
 * @see https://spec.matrix.org/v1.13/identity-service-api/#get_matrixidentityv2terms_response-200_policy-object
 */
export interface Policy {
    /**
     * The version for the policy.
     * There are no requirements on what this might be and could be “alpha”, semantically versioned, or arbitrary.
     */
    version: string;
    /**
     * The policy information for the specified language.
     * @remarks the type has to include a union with string due to limitations in the type system.
     */
    [lang: string]: InternationalisedPolicy | string;
}

/**
 * Response from the Terms API for Identity servers
 * @see https://spec.matrix.org/v1.13/identity-service-api/#get_matrixidentityv2terms
 */
export interface Terms {
    policies: {
        [policyName: string]: Policy;
    };
}
