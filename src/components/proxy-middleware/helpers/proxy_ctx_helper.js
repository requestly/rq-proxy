import { 
  CONSTANTS as GLOBAL_CONSTANTS,
} from "@requestly/requestly-core"

import qs from 'qs';

function extractUrlComponent(url, name) { // need this in proxy
  const myUrl = new URL(url);

  switch (name) {
    case GLOBAL_CONSTANTS.URL_COMPONENTS.URL:
      return url;
    case GLOBAL_CONSTANTS.URL_COMPONENTS.PROTOCOL:
      return myUrl.protocol;
    case GLOBAL_CONSTANTS.URL_COMPONENTS.HOST:
      return myUrl.host;
    case GLOBAL_CONSTANTS.URL_COMPONENTS.PATH:
      return myUrl.pathname;
    case GLOBAL_CONSTANTS.URL_COMPONENTS.QUERY:
      return myUrl.search;
    case GLOBAL_CONSTANTS.URL_COMPONENTS.HASH:
      return myUrl.hash;
  }

  console.error("Invalid source key", url, name);
}

/**
 *
 * @param queryString e.g. ?a=1&b=2 or a=1 or ''
 * @returns object { paramName -> [value1, value2] }
 */
export function getQueryParamsMap(queryString) {
  return qs.parse(queryString, { ignoreQueryPrefix: true });
}

export const get_request_url = (ctx) => {
  return (
    (ctx.isSSL ? "https://" : "http://") +
    ctx.proxyToServerRequestOptions.headers.host || ctx.proxyToServerRequestOptions.host +
    ctx.proxyToServerRequestOptions.url
  );
};

export const get_original_request_headers = (ctx) => {
  // TODO: This needs to be fetched from ctx.clientToProxy headers
  return ctx.proxyToServerRequestOptions.headers;
};

export const get_original_response_headers = (ctx) => {
  // TODO: This needs to be fetched from ctx.clientToProxy headers
  return ctx?.serverToProxyResponse?.headers || {};
};

export const is_request_preflight = (ctx) => {
  if (
    // Request method is OPTIONS
    ctx.clientToProxyRequest.method.toLowerCase() === "options" &&
    // Has "origin" or "Origin" or "ORIGIN" header
    (ctx.clientToProxyRequest.headers["Origin"] ||
      ctx.clientToProxyRequest.headers["origin"] ||
      ctx.clientToProxyRequest.headers["ORIGIN"]) &&
    // Has Access-Control-Request-Method header
    (ctx.clientToProxyRequest.headers["Access-Control-Request-Method"] ||
      ctx.clientToProxyRequest.headers["access-control-request-method"] ||
      ctx.clientToProxyRequest.headers["ACCESS-CONTROL-REQUEST-METHOD"])
  )
    return true;
  else return false;
};

export const get_response_options = (ctx) => {
  const options = {};

  options.status_code = ctx.serverToProxyResponse.statusCode;
  options.headers = ctx.serverToProxyResponse.headers;

  return options;
};

export const get_request_options = (ctx) => {
  return {
    ...ctx.proxyToServerRequestOptions,
    query_params: get_json_query_params(ctx),
  };
};

export const get_json_query_params = (ctx) => {
  const url = get_request_url(ctx);
  let queryString = extractUrlComponent(url, GLOBAL_CONSTANTS.URL_COMPONENTS.QUERY);
  return getQueryParamsMap(queryString) || null;
};

export const getRequestHeaders = (ctx) => {
  if (ctx && ctx.proxyToServerRequestOptions) {
    return ctx.proxyToServerRequestOptions.headers || {};
  }

  return {};
};

export const getRequestContentTypeHeader = (ctx) => {
  return getRequestHeaders(ctx)["content-type"];
};

export const getResponseHeaders = (ctx) => {
  if (ctx && ctx.serverToProxyResponse) {
    return ctx.serverToProxyResponse.headers || {};
  }

  return {};
};

export const getResponseContentTypeHeader = (ctx) => {
  return getResponseHeaders(ctx)["content-type"];
};

export const getResponseStatusCode = (ctx) => {
  if (ctx && ctx.serverToProxyResponse) {
    return ctx.serverToProxyResponse.statusCode;
  }
};


const HEADERS_IGNORED_ON_REDIRECT = ["authorization"];
const CUSTOM_QUERY_PARAM_PREFIX = "x-rq-";

export function getExtraQueryParamsForRedirect(ctx) {
  const customQueryParams = {};
  HEADERS_IGNORED_ON_REDIRECT.forEach((ignoredHeader) => {
    if(ctx.rq.original_request.headers[ignoredHeader]) {
      const customQueryParamKey = `${CUSTOM_QUERY_PARAM_PREFIX}${ignoredHeader}`;
      customQueryParams[customQueryParamKey] = ctx.rq.original_request.headers[ignoredHeader];
    }
  })
  return customQueryParams;
}

function extractDataFromRQQueryParams(ctx) {
  const metaData = {};
  const queryParams = get_json_query_params(ctx);
  for (const param in queryParams) {
    if (param.startsWith(CUSTOM_QUERY_PARAM_PREFIX)) {
      const key = param.substring(CUSTOM_QUERY_PARAM_PREFIX.length);
      metaData[key] = queryParams[param]
      delete queryParams[param];
    }
  }
  
  const newUrl = new URL(get_request_url(ctx));
  for (const [key, value] of Object.entries(queryParams)) {
    newUrl.searchParams.set(key, value);
  }

  ctx.proxyToServerRequestOptions.path = newUrl.pathname;
  ctx.proxyToServerRequestOptions.url = newUrl.toString();

  ctx.rq.set_original_request({ path: newUrl.pathname, query_params: queryParams });
}

export function handleRQMetadataInQueryParam(ctx) {
  const headersToBeAddedToRequest = extractDataFromRQQueryParams(ctx);
  if (headersToBeAddedToRequest) {
    for (const [name, value] in Object.entries(headersToBeAddedToRequest)) {
      ctx.proxyToServerRequestOptions.headers[name] = value;
    }
  }
  ctx.rq.set_original_request({ headers: ctx.proxyToServerRequestOptions.headers });
}