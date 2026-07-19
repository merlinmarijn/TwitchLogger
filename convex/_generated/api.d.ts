/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as channels from "../channels.js";
import type * as chatTabs from "../chatTabs.js";
import type * as debug from "../debug.js";
import type * as functions from "../functions.js";
import type * as lib_clientMessage from "../lib/clientMessage.js";
import type * as lib_ingestionAuth from "../lib/ingestionAuth.js";
import type * as lib_maintenancePacing from "../lib/maintenancePacing.js";
import type * as lib_messageFilters from "../lib/messageFilters.js";
import type * as lib_messagePagination from "../lib/messagePagination.js";
import type * as messages from "../messages.js";
import type * as platforms from "../platforms.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  channels: typeof channels;
  chatTabs: typeof chatTabs;
  debug: typeof debug;
  functions: typeof functions;
  "lib/clientMessage": typeof lib_clientMessage;
  "lib/ingestionAuth": typeof lib_ingestionAuth;
  "lib/maintenancePacing": typeof lib_maintenancePacing;
  "lib/messageFilters": typeof lib_messageFilters;
  "lib/messagePagination": typeof lib_messagePagination;
  messages: typeof messages;
  platforms: typeof platforms;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
