> 本文由 [简悦 SimpRead](http://ksria.com/simpread/) 转码， 原文地址 [github.com](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)

> uBlock Origin - An efficient blocker for Chromium and Firefox. Fast and lean. - gorhill/uBlock

uBlock Origin (uBO) supports most of the EasyList filter syntax. You can refer to existing filter syntax documentation from [Adblock Plus](https://help.adblockplus.org/adblock-plus-help-center/how-to-write-filters) (ABP) and [AdGuard](https://kb.adguard.com/en/general/how-to-create-your-own-ad-filters) (AG).

While uBO does not support some specific cases, it further extends the EasyList filter syntax, which also may share with AG's extended syntax. [Here](https://github.com/gorhill/uBlock/wiki/Syntax-quirks) are the most surprising cases documented.

Starting with [1.46.1b15](https://github.com/gorhill/uBlock/commit/81498474d6d440b032681aa9952d593749b39efb), you can use regex-based values as target domain for static extended filters, see more [here](#hostname-regex).

*   [Not supported](#not-supported)
*   [Pre-parsing directives](#pre-parsing-directives)
*   [Extended syntax](#extended-syntax)
    *   [Static network filtering](#static-network-filtering)
        *   [HOSTS files](#hosts-files)
        *   [Modifier filters](#modifier-filters)
        *   [Narrowing options for network filters ↪](https://github.com/gorhill/uBlock/wiki/Filter-Performance#narrowing-options-for-network-filters)
    *   [Static extended filtering](#static-extended-filtering)
        *   [Entity](#entity)
        *   [Hostname regex](#hostname-regex)
        *   [Specific-generic](#specific-generic)
        *   [Cosmetic filters](#cosmetic-filters)
            *   [Procedural cosmetic filters ↪](https://github.com/gorhill/uBlock/wiki/Procedural-cosmetic-filters)
        *   [Action operators](#action-operators)
        *   [HTML filters](#html-filters)
        *   [Response header filtering](#response-header-filtering)
        *   [Scriptlet injection](#scriptlet-injection)
            *   [Resources library ↪](https://github.com/gorhill/uBlock/wiki/Resources-Library)

It is not supported. The `document` option used with an exception filter is to disable uBO. The `document` option in static exception filters is for the sake of "acceptable ads" support, which uBO does not support.

The reason it is not supported is to be sure that users explicitly disable uBO themselves if they wish (through [Trusted sites](https://github.com/gorhill/uBlock/wiki/How-to-mark-a-web-site-as-trusted) feature), not having some external filter list decide for them.

Note: it [still works](https://github.com/gorhill/uBlock/issues/1754) to negate [strict blocking](https://github.com/gorhill/uBlock/wiki/Strict-blocking) when explicitly enabled by blocking filter `document` option.

It is not supported.

This option gets used with an exception filter to disable _generic_ network filters on target pages. _Generic_, in this case, means network filters without a `domain=` filter option. Filters such as `||example.com^` are still considered generic.

This option is not supported because using such a filter option would cause large numbers of filters to be silently disabled for a site where applied.

For instance, when used for a specific site, the `genericblock` option would cause all the filters in hosts files to be disabled, including those from the malware lists. EasyPrivacy and other anti-tracking lists also contain countless so-called "generic" filters, and as a consequence, these would also end up being disabled.

**Supported** starting with uBO [1.23.0](https://github.com/gorhill/uBlock/commit/23c4c80136ba4974a6444488ef8162ba75b0cb84), also aliased as `ehide`.

Before 1.23.0 it was translated internally to `generichide`. `elemhide` was only available as ["No cosmetic filtering"](https://github.com/gorhill/uBlock/wiki/Per-site-switches#no-cosmetic-filtering) switch.

Keep in mind that `generichide` is a cosmetic filtering-related option, and using it has no negative consequence concerning privacy since cosmetic filtering has no privacy value.

uBO 1.16.0 and above supports pre-parsing directives. Pre-parsing directives prefixed with `!#` means older versions of uBO or other blockers will see the pre-parsing directives as a comment and discard them.

The pre-parsing directives execute before a list's content is parsed and influence the final content of a filter list.

The `!#include` directive allows importing another filter list in place of where the directive appears. The purpose is to allow filter list maintainers to create filters specific to uBO while keeping their list compatible with other blockers. Other blockers will ignore the `!#include` directive because it will be seen as a comment and thus discarded. uBO will attempt to load the resource found at `[file name]` (the sub-list) and load its content into the current list.

The sub-list **must** be in the same directory as the main one. It is not allowed to load a sub-list located outside where the current one resides.

Correct usage:

*   `!#include ublock-filters.txt`
*   `!#include ublock/filters.txt`

Incorrect usage:

*   `!#include https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters.txt`
*   `!#include ../filters.txt`

Related discussion and live example of usefulness:

*   [https://github.com/yourduskquibbles/webannoyances/issues/67](https://github.com/yourduskquibbles/webannoyances/issues/67)

The `!#if` directive allows filter list maintainers to create areas in a filter list that get parsed **only** if certain conditions are met (or not met). For example, use this to create filters specific to a particular browser.

For example, to compile a block of filters only if uBO is running as a Firefox add-on:

```
!#if env_firefox
...
!#endif

```

Another example is to compile a block of filters only if uBO is _not_ running as a Firefox add-on (you can negate using `!`):

```
!#if !env_firefox
...
!#endif

```

Support for preprocessor directives is the result of discussion with AG developers. See [https://github.com/AdguardTeam/AdguardBrowserExtension/issues/917](https://github.com/AdguardTeam/AdguardBrowserExtension/issues/917).

After [1.50.1b9](https://github.com/gorhill/uBlock/commit/194354cd5d776f99c10381102afea13e5d018756), uBO is fully compatible with the `!#if` directives found throughout AdGuard's filter lists.

uBO supports only the following, and anything else gets ignored:

<table role="table"><thead><tr><th>Token</th><th>Value</th><th>Version</th></tr></thead><tbody><tr><td><code>ext_abp</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/00b790ce7210d7faa9b5a06d748d415bc1879056">1.29.3b7</a></td></tr><tr><td><code>ext_ublock</code></td><td><strong>true</strong></td><td></td></tr><tr><td><code>ext_ubol</code></td><td><em>true</em> on uBlock Origin Lite</td><td><a href="https://github.com/gorhill/uBlock/commit/35f4bdd113f275d124c35962c51add7582dabf49">1.44.3b12</a></td></tr><tr><td><code>ext_devbuild</code></td><td><em>true</em> on the development build</td><td><a href="https://github.com/gorhill/uBlock/commit/464b54bbc6432fa07c85820b37f72b77f0855638">1.48.1b1</a></td></tr><tr><td><code>env_chromium</code></td><td><em>true</em> on all Chromium-based browsers</td><td></td></tr><tr><td><code>env_edge</code></td><td><em>true</em> on Edge (legacy)</td><td></td></tr><tr><td><code>env_firefox</code></td><td><em>true</em> on Firefox</td><td></td></tr><tr><td><code>env_mobile</code></td><td><em>true</em> on mobile devices</td><td></td></tr><tr><td><code>env_safari</code></td><td><em>true</em> on Safari (legacy, up to 12 / macOS Mojave)</td><td></td></tr><tr><td><code>env_mv3</code></td><td><em>true</em> when uBOL is assembled, and <em>false</em> otherwise</td><td><a href="https://github.com/gorhill/uBlock/commit/873c2e726469f659b2e5dda504626079c2457a27">1.44.5b15</a></td></tr><tr><td><code>false</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/1d805fb9da1aad918d02cc74796d5aa5e974b184">1.22.0</a></td></tr><tr><td><code>cap_html_filtering</code></td><td><em>true</em> when browser supports <a href="#html-filters">HTML filtering</a></td><td></td></tr><tr><td><code>cap_user_stylesheet</code></td><td><em>true</em> on Firefox, Chromium 66+, supports style injection by <a href="https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/insertCSS" rel="nofollow"><code>tabs.insertCSS</code></a></td><td></td></tr><tr><td><code>adguard</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/83c01fb3525bbede86c54fe06caa3eb8bc8eb0ef">1.29.0</a></td></tr><tr><td><code>adguard_app_android</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/00b790ce7210d7faa9b5a06d748d415bc1879056">1.29.3b7</a></td></tr><tr><td><code>adguard_app_ios</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/00b790ce7210d7faa9b5a06d748d415bc1879056">1.29.3b7</a></td></tr><tr><td><code>adguard_app_mac</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/00b790ce7210d7faa9b5a06d748d415bc1879056">1.29.3b7</a></td></tr><tr><td><code>adguard_app_windows</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/e44a568278678e04b508c2bc1b8a94a2c54b848c">1.29.0</a></td></tr><tr><td><code>adguard_ext_android_cb</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/00b790ce7210d7faa9b5a06d748d415bc1879056">1.29.3b7</a></td></tr><tr><td><code>adguard_ext_chromium</code></td><td><em>true</em> on Chromium based browsers</td><td><a href="https://github.com/gorhill/uBlock/commit/83c01fb3525bbede86c54fe06caa3eb8bc8eb0ef">1.28.1b6</a></td></tr><tr><td><code>adguard_ext_edge</code></td><td><em>true</em> on Edge (legacy)</td><td><a href="https://github.com/gorhill/uBlock/commit/83c01fb3525bbede86c54fe06caa3eb8bc8eb0ef">1.29.0</a></td></tr><tr><td><code>adguard_ext_firefox</code></td><td><em>true</em> on Firefox</td><td><a href="https://github.com/gorhill/uBlock/commit/83c01fb3525bbede86c54fe06caa3eb8bc8eb0ef">1.29.0</a></td></tr><tr><td><code>adguard_ext_opera</code></td><td><em>true</em> on Chromium</td><td><a href="https://github.com/gorhill/uBlock/commit/83c01fb3525bbede86c54fe06caa3eb8bc8eb0ef">1.29.0</a></td></tr><tr><td><code>adguard_ext_safari</code></td><td><strong>false</strong></td><td><a href="https://github.com/gorhill/uBlock/commit/00b790ce7210d7faa9b5a06d748d415bc1879056">1.29.3b7</a></td></tr></tbody></table>

Starting from [1.22.0](https://github.com/gorhill/uBlock/commit/1d805fb9da1aad918d02cc74796d5aa5e974b184), you can use the `!#if false` directive to disable a large block of your filters without having to remove them.

Before this version, you could use negated `ext_ublock` since this token always equals true in uBO.

Starting from [1.50.1b9](https://github.com/gorhill/uBlock/commit/194354cd5d776f99c10381102afea13e5d018756), you can use the `!#else` directive:

```
!#if cap_html_filtering
example.com##^script:has-text(fakeAd)
!#else
example.com##+js(rmnt, script, fakeAd)
!#endif

```

uBO extends ABP filter syntax.

*   [_](#_-aka-noop) _(aka "noop")_
*   [*](#-aka-all-urls) _(aka "all URLs")_
*   [$1p](#1p) _([$first-party](#first-party))_
*   [$3p](#3p) _($third-party)_
*   [$all](#all) _(all network-based types + $popup + $document + $inline-font + $inline-script)_
*   [$badfilter](#badfilter)
*   [$css](#css) _($stylesheet)_
*   [$cname](#cname)
*   [$denyallow](#denyallow)
*   [$document](#document)
*   [$domain](#domain) _([$from](#from))_
*   [$elemhide](#elemhide-1) _($ehide)_
*   [$font](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$frame](#frame) _($subdocument)_
*   ~$genericblock~ Not supported
*   [$generichide](#generichide) _($ghide)_
*   [$header](#header)
*   [$image](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$important](#important)
*   [$inline-script](#inline-script)
*   [$inline-font](#inline-font)
*   [$ipaddress](#ipaddress)
*   [$match-case](#match-case)
*   [$media](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$method](#method)
*   [$object](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$other](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$permissions](#permissions)
*   [$ping](#ping)
*   [$popunder](#popunder)
*   [$popup](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$script](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$specifichide](#specifichide) _($shide)_
*   [$strict1p](#strict1p)
*   [$strict3p](#strict3p)
*   [$to](#to)
*   [$top](#top)
*   ~$webrtc~ `example.com##+js(nowebrtc)`
*   [$websocket](https://help.adblockplus.org/hc/en-us/articles/360062733293#options)
*   [$xhr](#xhr) _($xmlhttprequest)_
*   [$csp](#csp)
*   [$empty](#empty) _($redirect=empty)_
*   [$mp4](#mp4) _($redirect=noopmp4-1s)_
*   [$redirect](#redirect)
*   [$redirect-rule](#redirect-rule)
*   [$removeparam](#removeparam)
*   [$replace](#replace) (only from a trusted-source origin)
*   [$uritransform](#uritransform) (only from a trusted-source origin)
*   [$urlskip](#urlskip) (only from a trusted-source origin)

uBO can also parse HOSTS file-like resources. All hostname entries from a HOSTS file resource from uBO's point of view will be syntactically equivalent to a filter using the form `||hostname^`.

However, this creates an ambiguity with the ABP filter syntax, which is pattern-based. For example, consider the following filter entry:

ABP filter syntax dictates that this gets interpreted as "block network requests whose URL contains `example.com` at any position".

However, in uBO, the interpretation will be "block network requests to the site `example.com` and all of its subdomains", which is the equivalent to `||example.com^`. Note that this includes blocking the main document itself, see ["Strict blocking"](https://github.com/gorhill/uBlock/wiki/Strict-blocking) and [`document` option](#document).

So in uBO, any pattern that reads as a valid hostname will be assumed to be equivalent to a filter of the form `||example.com^`. If ever you want such a filter syntactically parsed according to ABP's interpretation, add a wildcard at the end:

If the filter is a filename, it is best to prepend with a slash to ensure it's not parsed as a hostname:

Related:

*   [Hosts files in uBO: Block more, way more](https://github.com/gorhill/uBlock/wiki/Block-more%2C-way-more)
*   [Hosts files at OS level vs hosts files in uBO](https://github.com/gorhill/uBlock/wiki/Counterarguments#just-use-a-hosts-file)

Just a placeholder.

[Implemented](https://github.com/uBlockOrigin/uBlock-issues/issues/1356#issuecomment-735280463) to resolve ambiguity in `$removeparam` filters with Regular Expression parameters detected as plain Regular Expression filters because of leading and trailing slashes:

```
/ad-$removeparam=/^foo=bar\d$/,_

```

Starting from [1.50.1b11](https://github.com/gorhill/uBlock/commit/33b409dd5baee1fd48a02bac757dc599373f1aa5), you can use the `_` option to also resolve readability issues by supporting multiple instances of the `_` option in a single filter:

```
||example.com$_,removeparam=/^ss\\$/,_,image
||example.com$replace=/bad/good/,___,~third-party

```

The wildcard character `*` gets used to apply a filter to **all** URLs. Not recommended unless you further narrow the filter using filter options. Examples:

*   `*$third-party`: block all 3rd-party network requests.
*   `*$script,domain=example.com`: block all network requests to fetch script resources at `example.com`.

Usually, it is far more convenient to use [dynamic filtering rules](https://github.com/gorhill/uBlock/wiki/Dynamic-filtering) instead of generic static filters.

Equivalent to [`first-party`](#first-party) uBO option, which in turn is negated `third-party` option (`~third-party`).

Filter will match on requests to currently visited domain.

Equivalent to `third-party` option.

Filter will match on requests to other than currently visited domain.

New in [1.20.0](https://github.com/gorhill/uBlock/commit/1888033070003cd5e6a3687a4029448bf41fccea).

The `all` option is equivalent to specifying all network-based types + `popup`, `document`, `inline-font` and `inline-script`.

Example:

Above will block all network requests, block all popups and prevent inline fonts/scripts from `bet365.com`. The EasyList-compatible syntax does not allow this when using only `||bet365.com^`.

Used to disable an existing filter. Occasionally disabling a blocking filter is better than creating an exception filter. Just for example's sake, let's say that a mind-absent filter list maintainer added the following filter to their list:

Now all images from everywhere are blocked on your side. An exception filter (`@@*$image`) is not a good solution because it would also cause images that should get blocked legitimately to no longer be blocked. In such case, the `badfilter` option is best:

It will cause the `*$image` filter to get discarded. Appending the `badfilter` option to any instance of static network filter will prevent the loading of that filter.

After [1.19.0](https://github.com/gorhill/uBlock/commit/3f3a1543ea7fa51d700157a7f6bf0da08dd7a32b), any filter which fulfills ALL the following conditions:

*   Is of the form `|https://` or `|http://` or `*`; and
*   Does have a `domain=` option; and
*   Does not have a negated domain in its `domain=` option; and
*   Does not have `csp` option; and
*   Does not have a `redirect=` option

Will process in a certain way:

*   The `domain=` option will be decomposed to create as many distinct filters as there are values in the `domain=` option.
*   It now becomes possible to `badfilter` only one of the distinct filters without having to `badfilter` them all.
*   The logger will always report these special filters with only a single hostname in the `domain=` option.

Equivalent to `stylesheet` [option](https://help.eyeo.com/en/adblockplus/how-to-write-filters#options). For convenience.

Framework compatibility: Firefox MV2-only

New in [1.26.0](https://github.com/gorhill/uBlock/commit/c3bc2c741d61db3e99b313835c2ae34a4a008359).

When used in an exception filter, it will bypass blocking CNAME uncloaked requests for the current (specified) document.

Network requests resulting from resolving a [canonical name](https://en.wikipedia.org/wiki/CNAME_record) are subject to filtering. Creating exception filters using the `cname` option can bypass this filtering.

Example:

The filter above tells the network filtering engine to accept network requests which fulfill all the following conditions:

*   network request is blocked
*   network request is that of an unaliased hostname

Filter list authors are discouraged from using exception filters of the `cname` type unless there is no other practical solution such that the maintenance burden becomes the more significant issue. These exception filters should be as narrow as possible. For example, they apply to a specific domain, etc.

New in [1.26.0](https://github.com/gorhill/uBlock/commit/c3bc2c741d61db3e99b313835c2ae34a4a008359).

The purpose of `denyallow` is to bring default-deny/allow-exceptionally ability into the static network filtering arsenal.

Example:

```
*$3p,script,denyallow=x.com|y.com,domain=a.com|b.com

```

The above filter tells the network filtering engine when the context is `a.com` or `b.com`; it needs to block all 3rd-party scripts except those from `x.com` and `y.com`.

Note that the [`domain=`](#domain) option is required!

Essentially, the new `denyallow` option makes it easier to implement default-deny/allow-exceptionally in static filter lists. It had to be done before with unwieldy regular expressions[1] or through the mix of broadly blocking and exception filters[2].

[_"Entity"_](#entity) wildcard matching is not supported.

[1] [https://hg.adblockplus.org/ruadlist/rev/f362910bc9a0](https://hg.adblockplus.org/ruadlist/rev/f362910bc9a0)

[2] Typically filters whose patterns are of the form `|http*://`

See also: [`to`](#to)

Alias: `doc`

It is a _type_ option (like `image` or `script`) that specifies the _main frame_ (a.k.a. the root document) of a web page. This option is automatically enabled in filters indicating only the host part of the URL (see ["HOSTS files" section](#hosts-files)), causing web pages that match the filter to get subjected to ["Strict blocking"](https://github.com/gorhill/uBlock/wiki/Strict-blocking).

See also: [`all`](#all)

Alias: [`from`](#from)

Restrict the filter to be applied only on the specified domain(s).

Use the `|` symbol to join multiple domains.

Preceding the domain name by `~` will prevent the filter from being applied on this domain.

Starting with [1.28.0](https://github.com/gorhill/uBlock/commit/3c67d2b89f8ac6d680e74af3e11b916889f7feed) support for [_"entity"_](#entity) matching has been added. You can now use `filter$domain=google.*` to apply a filter to pages on all top-level domains of the specified domain.

Example:

```
||doubleclick.net^$script,domain=auto-motor-und-sport.de
||adnxs.com^$domain=bz-berlin.de|metal-hammer.de|musikexpress.de|rollingstone.de|stylebook.de
/adsign.$domain=~adsign.no

```

Starting with [1.46.1b17](https://github.com/gorhill/uBlock/commit/b1de8d3fe48755da58268ba86dccd5d76940b613) support for regex-based values has been added. Example of usage: `@@*$ghide,domain=/img[a-z]{3,5}\.buzz/`

Related discussion: [uBlockOrigin/uBlock-issues#2234](https://github.com/uBlockOrigin/uBlock-issues/discussions/2234)

Regex-based domain values can be negated just like plain or entity-based values: `*$domain=~/regex.../`

See also: [`ipaddress`](#ipaddress) and [`to`](#to).

Alias: `ehide`

Before uBO [1.23.0](https://github.com/gorhill/uBlock/commit/23c4c80136ba4974a6444488ef8162ba75b0cb84), this was being translated internally to `generichide`.

When used in an exception filter, this will turn off all cosmetic filtering on matching pages.

Equivalent to `~third-party` [option](https://help.eyeo.com/en/adblockplus/how-to-write-filters#options). Provided strictly for convenience (0.9.9.0).

Equivalent to `subdocument` [option](https://help.eyeo.com/en/adblockplus/how-to-write-filters#options). For convenience.

New in [1.46.1b0](https://github.com/gorhill/uBlock/commit/19f8b30d577ac17097b8060adfc92093866e26d8).

It is just an alias for the `domain=` option. The logger will render `domain=` network filters using the `from=` version.

See: [`domain`](#domain)

Alias: `ghide`.

When used in an exception filter, it will turn off _generic_ cosmetic filtering on matching pages.

Generic cosmetic filters are hiding filters that apply to all pages - `##.ad-class`.

New in [1.32.0](https://github.com/gorhill/uBlock/commit/bde3164eb445a4e74acca303ec9fa07f82ba1b1c). As of [1.52.3b16](https://github.com/gorhill/uBlock/releases/tag/1.52.3b16) it is enabled by default[[1]](https://github.com/gorhill/uBlock/commit/c96a673338aed902cb9c62b5e8159ae4b4825003)

Ability to filter network **responses** according to whether a specific **response header** is present and whether or not it matches a distinct value.

For example:

```
*$script,header=via:1.1 google

```

The above filter blocks network requests of type `script`, which has a response HTTP header named `via`, which value matches the string `1.1 google` literally.

The header value can get set to a regex literal by bracing the header value with the usual forward slashes, `/.../`:

```
*$script,header=via:/1\.1\s+google/

```

The header value can be prepended with `~` to reverse the comparison:

```
*$script,header=via:~1.1 google

```

The header value is optional and may be left out to test only for the presence of a specific header:

Using generic exception filters to disable specific block `header=` filters, i.e. `@@*$script,header` will override the block `header=` filters given in the example above.

**Important:** Filter authors must use as many narrowing filter options as possible when using the `header=` option and only use the `header=` option when other filter options are insufficient.

A potential use case is to block [Google Tag Manager scripts proxied as the first party in the subdomain of the websites](https://www.simoahava.com/analytics/server-side-tagging-google-tag-manager/):

```
*$1p,strict3p,script,header=via:1.1 google

```

Where connection:

*   is weakly 1st-party to the context.
*   is not strictly 1st-party to the context.
*   is of type `script`.
*   has a response HTTP header named `via` whose value matches `1.1 google`.

Block requests whose responses have the `Set-Cookie` header with any value:

```
||example.com^$header=set-cookie 

```

Unblock requests whose responses have the `Set-Cookie` header with value matching the `foo, bar$` regular expression:

```
@@||example.com^$header=set-cookie:/foo\, bar\$/ 

```

To remove response headers, see: [`Response header filtering`](#response-header-filtering).

The filter option `important` means to ignore all _exception_ filters (those prefixed with `@@`). It will allow you to block specific network requests with 100% certainty.

**It applies only to network _block_ filters**

Example: `||google-analytics.com^$important,third-party` will block all network requests to `google-analytics.com`, disregarding any existing network _exception_ filters.

Disable inline script tags in the main page via CSP: `||example.com^$inline-script`.

See also: [`csp`](#csp)

Disable inline font tags in the main page via CSP: `||example.com^$inline-font`.

Framework compatibility: Firefox MV2-only

New in 1.60.0.

The purpose is to block according to the IP address of a network request.

Firefox-based browsers: full support. Chromium-based browsers: only when the IP address is used directly in the URL in lieu of a hostname.

The value assigned to `ipaddress` can be ...

*   ... a plain string which must match exactly a given IP address  
    e.g. `ipaddress=192.168.1.1` to match exactly IP address `192.168.1.1`
*   ... a plain string followed by a wildcard at the end to match IP addresses starting with the pattern  
    e.g. `ipaddress=192.168.*` to match IP addresses starting with `192.168.` (wildcards inside: `192.168.*.1` or at the beginning: `*.168.1.1` are not supported, but a regex can be used in such cases)
*   ... a regex which will be matched against the IP address  
    e.g. `ipaddress=/^192.168.1.\d{1-2}/` to match IP address between `192.168.1.0` and `192.168.1.99`.
*   ... `lan` to match [IP addresses reserved for private networks](https://en.wikipedia.org/wiki/Reserved_IP_addresses)  
    
*   ... `loopback` to match [IP addresses reserved for loopback](https://en.wikipedia.org/wiki/Loopback#Virtual_loopback_interface)

Examples:

```
*$script,ipaddress=93.184.215.14
||xyz/|$xhr,3p,method=head,ipaddress=/^139\.45\.19[5-7]\./
*$all,ipaddress=::,domain=~0.0.0.0|~127.0.0.1|~[::1]|~[::]|~local|~localhost
*$ipaddress=93.184.*
*$method=post,ipaddress=lan

```

Cached resources do not have a valid IP address and thus can't be a match to `ipaddress` option.

The `ipaddress` value is not validated, so you can enter anything. Only one ipv4 or ipv6 address or regex is valid.

Exclusions `~` and `|` operators are not supported, e.g. `ipaddress=~192.168.1.1` or `ipaddress=192.168.1.1|192.168.8.4`, however as partial solution a regex can be used, examples:

```
(...) ipaddress=/^(?!95\.216\.7\.22|9\.9\.9\.9).*$/
(...) ipaddress=/^((?!95\.216\.7\.22|9\.9\.9\.9).)*$/

```

but the above regex solution is not perfect:

*   the first above regex excludes too much: `95.216.7.22y` which is unwanted (where `y` is any digit, for example `95.216.7.228`)
*   the second above regex even worse, excludes too much: `x95.216.7.22y` (where `x` and/or `y` is any digit, for example `195.216.7.22` or `95.216.7.221` or `195.216.7.221`)

But still some users might find them useful.

Technical notes

First commit in [1.59.1b15](https://github.com/gorhill/uBlock/commit/c6dedd253f). Related commit: [1.59.1b17](https://github.com/gorhill/uBlock/commit/030d7334e4), [1.59.1b19](https://github.com/gorhill/uBlock/commit/6acf97bf51), [1.59.1rc1](https://github.com/gorhill/uBlock/commit/6a042f152b513bbf5b3c8623ea3fbe2574ac0e24), [1.59.1rc4*](https://github.com/uBlockOrigin/uBlock-issues/issues/3381).

Lan/loopback values are supported (since [1.59.1b17](https://github.com/gorhill/uBlock/commit/030d7334e4)), related issue: [Possibility of Blocking Requests to localhost and Reserved IP Addresses by websockets?](https://github.com/uBlockOrigin/uBlock-issues/issues/1070).

Browser-provided `0.0.0.0` IP address will be ignored when DNS is proxied (since [1.59.1rc1](https://github.com/gorhill/uBlock/commit/6a042f152b513bbf5b3c8623ea3fbe2574ac0e24)), related issue: [Some rules may break websites that use socks proxy in Firefox](https://github.com/uBlockOrigin/uBlock-issues/issues/3379).

Cname uncloaking code has been rewritten to account for the `ipaddress` option (since [1.59.1b19](https://github.com/gorhill/uBlock/commit/6acf97bf51)), related issue: [Add AdGuard's $network support on Firefox](https://github.com/uBlockOrigin/uBlock-issues/issues/2792). This commit makes the DNS resolution code better suited for both filtering on cname and IP address. The change allows early availability of IP address so that `ipaddress` option can be matched at _onBeforeRequest_ time. As a result, it is now possible to block root document using `ipaddress` option -- so long as an IP address can be extracted before first _onBeforeRequest()_ call.

New in [1.31.1b8](https://github.com/gorhill/uBlock/commit/eae7cd58fe679d6765d62bb6c01e296d5301433a).

It is only for Regular Expression filters. Using this with any other filter will cause uBO to discard the filter.

Instructs uBO filtering engine to perform a case-sensitive match.

New in [1.46.1b0](https://github.com/gorhill/uBlock/commit/b6981877ba8f9011292aee9556c4d4c08c1bfd2d).

Related issue: [uBlockOrigin/uBlock-issues#2117](https://github.com/uBlockOrigin/uBlock-issues/issues/2117).

Ability to filter network requests according to their HTTP method.

This option supports a list of `|`-separated lowercased method names. Negated method names are allowed.

These are valid methods:

*   `connect`
*   `delete`
*   `get`
*   `head`
*   `options`
*   `patch`
*   `post`
*   `put`

As per DNR's own documentation:

*   [https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#type-RequestMethod](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#type-RequestMethod)

Example:

```
||google.com^$method=post|get
||example.com^$method=~get


```

The logger shows the method used for every network request. It's possible to filter the logger output for most-common methods: `get`, `head`, `post`.

New in [1.50.1b16](https://github.com/gorhill/uBlock/commit/5ebdbf3e24393560156fdcd931e31f901471f7f3).

Permissions Policy provides mechanisms to explicitly declare what functionality can and cannot be used on a website. It is similar to [Content Security Policy](#csp) but controls features instead of security behavior.

Examples of what you can do with Permissions Policy:

*   Change the default behavior of autoplay on mobile and third-party videos.
*   Restrict a site from using sensitive devices like the camera, microphone, or speakers.
*   Allow iframes to use the [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API).

Related discussion:

*   [https://github.com/uBlockOrigin/uBlock-issues/discussions/2714](https://github.com/uBlockOrigin/uBlock-issues/discussions/2714)

Reference:

*   [https://adguard.com/kb/general/ad-filtering/create-own-filters/#permissions-modifier](https://adguard.com/kb/general/ad-filtering/create-own-filters/#permissions-modifier)
*   [https://docs.w3cub.com/http/headers/feature-policy#directives](https://docs.w3cub.com/http/headers/feature-policy#directives)
*   [https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy)

Example:

```
||example.com^$permissions=browsing-topics=()

```

Difference with AdGuard's syntax: use `|` to separate permissions policy directives instead of `\,` -- uBO will replace instances of `|` with `,` :

```
*$permissions=oversized-images=()|unsized-media=()

```

However, it's best to not combine permissions policy to not break exception filters for either one of them.

When no type (e.g. `$doc`) is given, uBO will use `$document,subdocument` internally when the `permissions` option is used (same as with `csp`).

Blocks requests send by the [`ping`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#attr-ping) attribute on links and [Navigator.sendBeacon()](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon).

To block "popunders" windows/tabs where the original page redirects to an advertisement and the desired content loads in the newly created one. To be used in the same manner as the `popup` filter option, except that it will block popunders.

Alias: `shide`.

New in uBO [1.23.0](https://github.com/gorhill/uBlock/commit/23c4c80136ba4974a6444488ef8162ba75b0cb84).

When used in an exception filter, it will turn off _specific_ cosmetic filtering on matching pages.

Specific cosmetic filters apply only to pages in domains specified in the filter - `example.com##.ad-class`.

Framework compatibility: MV2-only

New in [1.32.0](https://github.com/gorhill/uBlock/commit/bde3164eb445a4e74acca303ec9fa07f82ba1b1c).

Strict first-party request.

The classic option [`1p`](#1p) can "weakly" match partyness. For example, a network request qualifies as 1st-party to its context if both the context and the request share the same _base domain_.

This new `strict1p` option can check for strict partyness. For example, a network request qualifies as 1st-party if both the context and the request share the same _hostname_.

For example:

<table role="table"><thead><tr><th>Context</th><th>Request</th><th><code>1p</code></th><th><code>strict1p</code></th></tr></thead><tbody><tr><td><code>www.example.org</code></td><td><code>www.example.org</code></td><td><strong>yes</strong></td><td><strong>yes</strong></td></tr><tr><td><code>www.example.org</code></td><td><code>subdomain.example.org</code></td><td><strong>yes</strong></td><td>no</td></tr><tr><td><code>www.example.org</code></td><td><code>www.example.com</code></td><td>no</td><td>no</td></tr></tbody></table>

Framework compatibility: MV2-only

New in [1.32.0](https://github.com/gorhill/uBlock/commit/bde3164eb445a4e74acca303ec9fa07f82ba1b1c).

Strict third-party requests.

The classic option [`3p`](#3p) can "weakly" match partyness. For example, a network request qualifies as 3rd-party to its context only if the context and the request _base domains_ are different.

This new `strict3p` option can check for strict partyness. For example, a network request qualifies as 3rd-party as soon as the context and the request _hostnames_ are different.

For example:

<table role="table"><thead><tr><th>Context</th><th>Request</th><th><code>3p</code></th><th><code>strict3p</code></th></tr></thead><tbody><tr><td><code>www.example.org</code></td><td><code>www.example.org</code></td><td>no</td><td>no</td></tr><tr><td><code>www.example.org</code></td><td><code>subdomain.example.org</code></td><td>no</td><td><strong>yes</strong></td></tr><tr><td><code>www.example.org</code></td><td><code>www.example.com</code></td><td><strong>yes</strong></td><td><strong>yes</strong></td></tr></tbody></table>

New in [1.46.1b0](https://github.com/gorhill/uBlock/commit/19f8b30d577ac17097b8060adfc92093866e26d8).

Related issue: [uBlockOrigin/uBlock-issues#2412](https://github.com/uBlockOrigin/uBlock-issues/discussions/2412).

The main motivation of this option is to give uBO's static network filtering engine an equivalent of DNR's [`requestDomains`](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#property-RuleCondition-requestDomains) and [`excludedRequestDomains`](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#property-RuleCondition-excludedRequestDomains).

`to=` is a superset of `denyallow=` with support for Entity-based syntax and also negated hostname.

For now `denyallow=` won't be deprecated, which still does not support entity-based syntax and for which negated domains are not allowed.

Examples:

```
||it^$3p,to=~example.it
*$script,from=beforeitsnews.com,to=google.*|gstatic.com


```

Starting with [1.46.1b17](https://github.com/gorhill/uBlock/commit/b1de8d3fe48755da58268ba86dccd5d76940b613) support for regex-based values has been added. Example of usage: `*$script,to=/img[a-z]{3,5}\.buzz/`

Related discussion: [uBlockOrigin/uBlock-issues#2234](https://github.com/uBlockOrigin/uBlock-issues/discussions/2234)

Regex-based domain values can be negated just like plain or entity-based values: `*$to=~/regex.../`

See also: [`denyallow`](#denyallow), [`from`](#from)

New in [1.70.1b5](https://github.com/gorhill/uBlock/commit/aebc108e3621f5ba507075add7d280a8fa149318).

Related issue: [uBlockOrigin/uAssets#17807](https://github.com/uBlockOrigin/uAssets/issues/17807#issuecomment-1806971916).

Restrict the filter to be applied only when the specified domain(s) match(es) the top context. The top context is typically the URL in the address bar of your browser.

This option also gives uBO's static network filtering engine an equivalent of DNR's [`topDomains`](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#property-RuleCondition-topDomains) and [`excludedTopDomains`](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#property-RuleCondition-excludedTopDomains).

Example, disable generic cosmetic filtering in all embedded contexts (direct and indirect) when hostname of the web page matches `example.com`:

```
@@*$generichide,top=example.com


```

Equivalent to `xmlhttprequest` [option](https://help.eyeo.com/en/adblockplus/how-to-write-filters#options). For convenience.

This option will inject an additional [`Content-Security-Policy`](https://developer.mozilla.org/en-US/docs/Glossary/CSP) header to the HTTP network response of the requested web page. This [will make Content Security Policy more strict](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy#multiple_content_security_policies) as designed by the specification. It will be applied to document requests only.

This special filter will not block matching resources but only apply HTTP header to pages matching it. Mixing it with other options specifying resource types like `image`, `script` or [`frame`](#frame) (`subdocument`) cannot happen. It can still be used with [`1p`](#1p) (`first-party`), [`3p`](#3p) (`third-party`) or [`domain`](#domain) options.

Because of how `csp` filters get implemented, they allow for some interesting applications. For example, you can block scripts only in some specific path on the page:

```
||example.com/subpage/*$csp=script-src 'none'

```

And even block them everywhere except the main page (note end anchor):

```
||example.com/*$csp=script-src 'none'
@@||example.com^|$csp=script-src 'none'

```

An exception filter for a specific `csp` blocking filter must have the same content of the `csp` option as the blocking filter. However, an exception filter with an empty `csp` option will disable all `csp` injections for the matching page:

CSP option syntax is unusual compared to other filters. Recommend to be used only by advanced users. It works in "allowlist" mode allowing data to be downloaded only from addresses explicitly specified in this option. However, uBO is adding its own second CSP header, which [as per specification](https://w3c.github.io/webappsec-csp/#multiple-policies) will merge into one final policy. It will enforce the most strict rules from both. For example, you can break a web page if the policy sent by the server allows `a.com` and `b.com` and your filter adds `c.com`; no request will be allowed.

Refer to ["Content Security Policy (CSP) Quick Reference Guide"](https://content-security-policy.com/) or [MDN documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy) for further syntax help.

See also [`denyallow`](#denyallow)

Deprecated, avoid using this option. See [deprecation notice from AdGuard](https://adguard.com/kb/general/ad-filtering/create-own-filters/#empty-modifier).

New in [1.22.0](https://github.com/gorhill/uBlock/commit/3e5c9e00ab3603ae0c02e08b007b084404bbb71d).

Redirects request to empty response.

The filter option `empty` is converted internally to `redirect=empty`.

See also: [`mp4`](#mp4), [`redirect`](#redirect)

Deprecated, avoid using this option. See [deprecation notice from AdGuard](https://adguard.com/kb/general/ad-filtering/create-own-filters/#mp4-modifier).

New in [1.22.0](https://github.com/gorhill/uBlock/commit/68ae847ba385c09c5efa511d18a18a4753af47be).

The `mp4` filter option will be converted to `redirect=noopmp4-1s` internally, and the `media` type is assumed.

See also: [`empty`](#empty), [`redirect`](#redirect)

The `redirect` option means _"block and redirect"_, and causes two filters to become created internally, a block filter and a redirect directive (`redirect-rule`).

A redirect directive causes a blocked network request to redirect to a local neutered resource version. The neutered resource must use a resource token. You can use [empty redirect resources](https://github.com/gorhill/uBlock/wiki/Resources-Library#available-empty-redirect-resources) and [URL-specific sanitized redirect resources (surrogates)](https://github.com/gorhill/uBlock/wiki/Resources-Library#available-url-specific-sanitized-redirect-resources-surrogates). At runtime, filters with unresolvable resource tokens get discarded.

You can use the `redirect=` filters with other static filter options. You can exclude them by using `@@`, they can be `badfilter`-ed, and their priority can increase with the `important` option.

Since multiple redirect directives can apply to a single network request, this introduces the concept of redirect priority.

By default, redirect directives have an implicit priority of `0`. Filter authors can declare explicitness by appending `:[integer]` (negative values are also supported) to the `redirect=` option token. For example:

```
||example.com/*.js$1p,script,redirect=noopjs:100

```

The priority dictates which redirect token out of many will ultimately become used. Cases of multiple `redirect=` directives applying to a single blocked network request are unlikely. All of these directives get reported in the logger. The effective one gets stated as the last one before redirection entry. Use explicit redirect priority only when a case of redirect ambiguity needs solving.

To disable a redirection, you can use an exception filter for the redirect directive (example for the filter above):

```
@@||example.com/*.js$1p,script,redirect-rule=noopjs

```

The filter above does not affect blocking filters, just matching redirect directives. You can broadly disable all redirect directives as follow:

```
@@||example.com/*.js$1p,script,redirect-rule

```

Before 1.32.0

Starting with [1.31.0](https://github.com/gorhill/uBlock/commit/157cef6034a8ec926c1e59c7e77f0a1fcbef473c), the `redirect=` option no longer is afflicted by static network filtering syntax quirks listed below.

*   Must specify resource type.
*   Special, reserved token `none` must be used to disable specific redirect filters.
*   Negated domains in the `domain=` option are not supported because of syntax ambiguity - [#310](https://github.com/uBlockOrigin/uBlock-issues/issues/310).
*   Redirections applied to all destinations (starting with `*`) cannot be narrowed by `first-party` or `~third-party` option [#3590](https://github.com/gorhill/uBlock/issues/3590).
*   Disable redirection by specifying `none` as the redirect. (Broken in [1.31.0](https://github.com/uBlockOrigin/uBlock-issues/issues/1388), fixed in [1.31.3b4](https://github.com/gorhill/uBlock/commit/904aa87e2aacb5fbfbb79ea702891e5be72d4b55))
*   Filters with unresolvable resource tokens at runtime will cause redirection to fail. (Changed in [1.31.1b8](https://github.com/gorhill/uBlock/commit/eae7cd58fe679d6765d62bb6c01e296d5301433a))

Available since [1.4.0](https://github.com/gorhill/uBlock/releases/tag/1.4.0).

Framework compatibility: MV2-only

Allows creating standalone redirect directives, without an implicit blocking filter.

For example, consider the following filter:

```
||example.com/ads.js$script,redirect=noop.js

```

The above filter will result in a block filter `||example.com/ads.js$script` **and** a matching redirect directive. Now consider the following filter:

```
||example.com/ads.js$script,redirect-rule=noop.js

```

The above filter will only cause a redirect directive to be created, not a block filter. Standalone redirect directives are helpful when blocking a resource is optional, but still want it to redirect should it ever become blocked by whatever means, whether through a separate block filter, a dynamic filtering rule, etc.

Available since [1.22.0](https://github.com/gorhill/uBlock/releases/tag/1.22.0).

Framework compatibility: MV2: full, MV3: partial

New in [1.32.0](https://github.com/gorhill/uBlock/commit/1e2eb037e5b4754feb4a40519951b3e7a73d545d).

To remove query parameters from the URL of network requests -- see also [AG's `removeparam`'s documentation](https://kb.adguard.com/en/general/how-to-create-your-own-ad-filters#removeparam-modifier). For historical reasons, `queryprune` is an alias of `removeparam` (avoid using `queryprune` as it is deprecated and support will get removed eventually).

`removeparam` is a modifier option (like `csp`) in that it does not cause a network request to be blocked but rather becomes modified before being emitted.

`removeparam` can be assigned a value. This value will determine which exact parameter from a query string will get removed:

The above filter tells uBO to remove the query parameter `utm_source` when present in a URL.

The value assigned to `removeparam` can be a literal regular expression, in which case uBO will remove query parameters matching the regular expression:

The above filter will remove all query parameters whose name starts with `utm_`, regardless of their value. When using a literal regular expression, it gets tested against each query parameter name-value pair assembled into a single string as `name=value`.

If no values are assigned, all query parameters on a given site will be removed:

```
||example.org^$removeparam

```

Poorly crafted `removeparam` filters can have harmful effects on performance. Experienced filter authors need to understand how to create optimal filters.

Cosmetically added params cannot be removed via `removeparam` (see related comment: [760#issuecomment-724703650](https://github.com/uBlockOrigin/uBlock-issues/issues/760#issuecomment-724703650) and invalid issues: [#1704](https://github.com/uBlockOrigin/uBlock-issues/issues/1704), [#1767](https://github.com/uBlockOrigin/uBlock-issues/issues/1767), [#1951](https://github.com/uBlockOrigin/uBlock-issues/issues/1951), [#2498](https://github.com/uBlockOrigin/uBlock-issues/issues/2498))

See also: [Filter Performance](https://github.com/gorhill/uBlock/wiki/Filter-Performance#removeparam-modifier)

Framework compatibility: Firefox MV2-only

New in [1.53.1b3](https://github.com/gorhill/uBlock/commit/7c3e060c01).

Can only be used in a trusted-source origin.

See [https://adguard.com/kb/general/ad-filtering/create-own-filters/#replace-modifier](https://adguard.com/kb/general/ad-filtering/create-own-filters/#replace-modifier)

[Documentation to be completed]

Candidate for deprecation, avoid usage. To be further discussed.

Can only be used in a trusted-source origin.

Transform the path/query/hash portion of a URL.

See [https://adguard.com/kb/general/ad-filtering/create-own-filters/#urltransform-modifier](https://adguard.com/kb/general/ad-filtering/create-own-filters/#urltransform-modifier)

[Documentation to be completed]

Technical notes

New in [1.52.3b12](https://github.com/gorhill/uBlock/commit/2e4525fe3c509a636fc67776cd728819f54a7de6) as `urltransform`.  
Renamed in [1.54.1b8](https://github.com/gorhill/uBlock/commit/cdc5e89f52242f465fdcdb84b9e040992b9cf07c) to `uritransform`.

Framework compatibility: MV2: full support; MV3: partial support

New in 1.60.0.

Can only be used in a trusted-source origin.

Extracts a URL from another URL according to one or more transformation steps, thereby skipping over intermediate network request(s) to remote servers. The main purpose is to bypass URLs designed to track whether a user visited a specific URL, typically used in click-tracking links.

The `urlskip=` option ...

*   ... is valid only when used in a trusted filter list
*   ... is a modifier, i.e. it cannot be used along with other modifier options in a single filter
*   ... is enforced only on network requests which are not blocked by other filter (New in [dev build 1.60.1rc0+](https://github.com/gorhill/uBlock/commit/d04dc4c767721fb13d91a67cb62ecad9b9219103)).
*   ... if a [strict-blocked](https://github.com/gorhill/uBlock/wiki/Strict-blocking) page matches a `urlskip=` filter, the page will show the user the destination URL as a result of applying the `urlskip` filter should they choose to proceed with the navigation (New in [dev build 1.60.1rc1+](https://github.com/gorhill/uBlock/commit/20b54185fac6f56ea871cc81554ee7ce8521d606)).

The syntax is `urlskip=[steps]`, where steps is a serie of space-separated directives representing the transformation steps to perform to extract the final URL to which a network request should be redirected.

Valid directives:

*   `?name`: extracts the value of parameter `name`
*   `&i`: extracts the name of the parameter at position `i` (1-based) (New in [dev build 1.60.1b6+](https://github.com/gorhill/uBlock/commit/64b2086ba4))
*   `#`: extracts the hash part as the current string
*   `/.../`: extracts the first capture group of a regex (New in [dev build 1.60.1b11+](https://github.com/gorhill/uBlock/commit/c86ed5287b))
*   `+https`:
    *   prepends the current string with `https://` protocol in case it lacks a leading protocol
    *   or replaces already existing leading `http://` protocol with `https://`
*   `-base64`: performs base64-decoding on the current string (New in [dev build 1.60.1b1+](https://github.com/gorhill/uBlock/commit/e81e70937f5b6f8f98bdd8e6f71af030486efab8))
*   `-safebase64`: performs safe base64-decoding on the current string (New in [dev build 1.61.3b0+](https://github.com/gorhill/uBlock/commit/bcc058eba75d4cbb2cd0447885f75e0705812883))
*   `-uricomponent`: performs URI component-decoding on the current string (New in [dev build 1.60.1b12+](https://github.com/gorhill/uBlock/commit/01eebffc1f))
*   `-blocked`: can be used to explicitly allow a `urlskip=` filter to also apply to blocked network requests (New in [dev build 1.60.1rc0](https://github.com/gorhill/uBlock/commit/d04dc4c767721fb13d91a67cb62ecad9b9219103))

At any given step, the currently extracted string may not necessarily be a valid URL, and more transformation steps may be needed to obtain a valid URL once all the steps are applied.

An unsupported step or a failed step will abort the transformation and no redirection will be performed.

The final computed URL must be a valid URL as per [URL API](https://developer.mozilla.org/en-US/docs/Web/API/URL_API), otherwise the filter will be ignored and no redirection will be performed.

Examples:

```
||example.com/path/to/tracker$urlskip=?url

```

The above filter will cause navigation to `https://example.com/path/to/tracker?url=https://example.org/` to automatically bypass navigation to `example.com` and navigate directly to `https://example.org/`.

It is possible to recursively extract URL parameters by using more than one directive, example:

```
||example.com/path/to/tracker$urlskip=?url ?to

```

The above filter will cause navigation to `https://example.com/path/to/tracker?url=https%3A%2F%2Fexample.org%2Fpath%2Fto%2Ftracker%3Fto%3Dhttps%253A%252F%252Fgithub.com%252F` to automatically bypass navigation to `example.com` & `example.org` and navigate directly to `https://github.com/`.

_Note:_ No skip will occur if not all extraction directives can be fulfilled in a given URL. For example, `https://example.com/path/to/tracker?url=https%3A%2F%2Fexample.org%2Fpath%2Fto%2Ftracker` won't be skipped by the filter above because the `?to` step can't be fulfilled.

```
||rdr.btrck.com/aff_c?$urlskip=?aff_sub3 +https

```

The above filter will cause navigation to `https://rdr.btrck.com/aff_c?offer_id=17&aff_id=1&source=55754&aff_sub=www.evekonomisi.net&aff_sub2=&aff_sub3=hepsiburada.com/philips-ca6700-10-espresso-makinesi-kirec-temizleme-solusyonu-p-HBCV00002YNJSF` (...) to automatically bypass navigation to `rdr.btrck.com` and navigate directly to `https://` + `hepsiburada.com/philips-ca6700-10-espresso-makinesi-kirec-temizleme-solusyonu-p-HBCV00002YNJSF` (...) (otherwise URL would be discarded due to a lack of a required protocol), the full URL is here:

(full URL spoiler)

`https://rdr.btrck.com/aff_c?offer_id=17&aff_id=1&source=55754&aff_sub=www.evekonomisi.net&aff_sub2=&aff_sub3=hepsiburada.com/philips-ca6700-10-espresso-makinesi-kirec-temizleme-solusyonu-p-HBCV00002YNJSF&aff_sub4=inf-www.evekonomisi.net-7324&aff_sub5=inf&url=https%3a%2f%2f7t4g.adj. st%2fproduct%3fsku%3dHBCV00002YNJSF%26adj_t%3d16v6nskj_16n3rgcj%26publisher_id%3d{transaction_id}%26offer_id%3d{offer_id}%26campaign%3dwinfluenced%26adgroup%3d{aff_sub}{source}%26creative%3d-aff_sub3- %26adj_deep_link%3dhbapp%253a%252f%252fproduct%253fsku%253dHBCV00002YNJSF%2526adj_t%253d16v6nskj_16n3rgcj%2526utm_source%253dwinfluenced%2526utm_medium%253dinfluencer%2526utm_campaign%253dwinfluenced%2526utm_content%253d- aff_sub3-%2526utm_term%253dinfluencer%2526wt_inf%253d{source}%26adj_install_callback%3dhttps%253a%252f%252fwinfluenced-pixel-bs56cx2ajq-ey. a.run.app%252fapi%252fpixel%252fcallback%252finstall%253fevent_type%253dInstall%2526linkid%253d95O2L4G8A2%2526ltoken%253d16v6nskj_16n3rgcj%2526app_id%253d%7Bapp_id%7D%2526offer_id%253d17%2526advertiser_id%253d{advertiser_id}%2526click_id%253d{transaction_id}%2526app_name%253d%7Bapp_name%7D%2526app_version%253d%7Bapp_version%7D%2526store%253d%7Bstore%7D%2526installed_at%253d%7Binstalled_at%7D%2526ip_address%253d%7Bip_address%7D%2526country%253d%7Bcountry%7D%2526device_name%253d%7Bdevice_name%7Dc%2526device_type%253d%7Bdevice_type%7D%2526os_name%253d%7Bos_name%7D%2526partner_parameters%253d%7Bpartner_parameters%7D%2526debug%253dtrue%26adj_event_callback_m2ril4_wapyen%3dhttps%253a%252f%252fwinfluenced- pixel-bs56cx2ajq-ey. a.run. app%252fapi%252fpixel%252fcallback%252fconversion%253fevent_type%253dConversion%2526linkid%253d95O2L4G8A2%2526ltoken%253d16v6nskj_16n3rgcj%2526etoken%253dm2ril4_wapyen%2526offer_id%253d%257bofferId%257d%2526advertiser_id%253d{advertiser_id}%2526app_id%253d%7Bapp_id%7D%2526click_id%253d{transaction_id}%2526ip_address%253d%7Bip_address%7D%2526country%253d%7Bcountry%7D%2526partner_parameters%253d%7Bpartner_parameters%7D%2526revenue_float%253d%7Brevenue_float%7D%2526currency%253d%7Bcurrency%7D%2526reporting_revenue%253d%7Breporting_revenue%7D%2526reporting_currency%253d%7Breporting_currency%7D%2526os_name%253d%7Bos_name%7D%2526debug%253dtrue`

```
||shrinkearn.com/full?$urlskip=?url -base64

```

The above filter will cause navigation to `https://shrinkearn.com/full?api=3dd1f43f5fded450a0e4691e503bf19b31f35f44&url=aHR0cHM6Ly9rcmFrZW5maWxlcy5jb20vdmlldy9zamJ1RmpQVTF2L2ZpbGUuaHRtbA==&type=2` to automatically bypass navigation to `shrinkearn.com` and navigate directly to `https://krakenfiles.com/view/sjbuFjPU1v/file.html` (which was `base64` decoded from: `aHR0cHM6Ly9rcmFrZW5maWxlcy5jb20vdmlldy9zamJ1RmpQVTF2L2ZpbGUuaHRtbA==`).

```
||pixiv.net/jump.php?$urlskip=&1

```

The above filter will cause navigation to: `https://www.pixiv.net/jump.php?https%3A%2F%2Fx.com%2FExample_Username` to automatically bypass navigation to `pixiv.net` and navigate directly to `https://x.com/Example_Username` (which was `%` decoded from `https%3A%2F%2Fx.com%2FExample_Username`).

```
||click.redditmail.com/CL0/$urlskip=/CL0\/.*?(www\.reddit\.com.+?)(?:\?|%3F)/ -uricomponent +https

```

The above filter will cause navigation to:

`https://click.redditmail.com/CL0/https://www.reddit.com/r/natureisfuckinglit/comments/1f7l41z/orca_pod_saying_hi_to_paddle_boarder/?%24deep_link=true&correlation_id=21bc5fa3-f0f4-43b5-92e4-6d2deb135b8a&post_fullname=t3_1f7l41z&post_index=2&ref=email_digest&ref_campaign=email_digest&ref_source=email&utm_content=post_author/1/01000191bd393638-90cd632e-f420-45fd-a732-27dc3e441ee2-000000/aBs5XoGsoLNHwf95BGM6JzVs4iNSldLNZ9hOBaWN_HA=369`

`https://click.redditmail.com/CL0/https:%2F%2Fwww.reddit.com/r/natureisfuckinglit/comments/1f7l41z/orca_pod_saying_hi_to_paddle_boarder/%3F%2524deep_link=true&correlation_id=21bc5fa3-f0f4-43b5-92e4-6d2deb135b8a&post_fullname=t3_1f7l41z&post_index=2&ref=email_digest&ref_campaign=email_digest&ref_source=email&utm_content=post_author/1/01000191bd393638-90cd632e-f420-45fd-a732-27dc3e441ee2-000000/aBs5XoGsoLNHwf95BGM6JzVs4iNSldLNZ9hOBaWN_HA=369%5D`

to automatically bypass navigation to `click.redditmail.com` and navigate directly to `https://` + `www.reddit.com/r/natureisfuckinglit/comments/1f7l41z/orca_pod_saying_hi_to_paddle_boarder/` (after it previously was `URI component` decoded).

Given the filter `||example.com^`, the filter:

```
||example.com/path/to/tracker$urlskip=?url

```

will not prevent strict-blocking when navigating to: `https://example.com/path/to/tracker?url=https://example.org/`

However, the filter:

```
||example.com/path/to/tracker$urlskip=-blocked ?url

```

will cause the strict-blocking to be ignored and allow navigation to proceed to the URL extracted as a result of applying the `urlskip=` filter: `https://example.org/`

Related discussion: [https://github.com/uBlockOrigin/uBlock-issues/issues/3206#issuecomment-2439627386](https://github.com/uBlockOrigin/uBlock-issues/issues/3206#issuecomment-2439627386)

Related issues:

*   [Add queryjump to redirect url](https://github.com/uBlockOrigin/uBlock-issues/issues/3206)
*   [Implement `$queryjump` for static network filter](https://github.com/uBlockOrigin/uBlock-issues/issues/2693)
*   [[Enhancement] Add option to _automatically_ visit embedded URLs w/o tracker](https://github.com/uBlockOrigin/uBlock-issues/issues/1784)

Technical notes

First commit in [1.59.1b22](https://github.com/gorhill/uBlock/commit/266ec4894b).  
Last commit in [1.60.1rc1](https://github.com/gorhill/uBlock/commit/20b54185fac6f56ea871cc81554ee7ce8521d606).

Static extended filtering
-------------------------

[](#static-extended-filtering)

Static extended filters are all of these forms:

```
[hostname(s)]##[expression]
[hostname(s)]#@#[expression]


```

The most common static extended filters are cosmetic filters, also known as "[element hiding filters](https://help.adblockplus.org/hc/en-us/articles/360062733293-How-to-write-filters#content-filters)"in ABP and"[cosmetic rules](https://adguard.com/kb/general/ad-filtering/create-own-filters/#cosmetic-rule)" in AG.

All static extended filters can apply to a specific _entity_. For example:

An _entity_ is defined as follows: a formal domain name with the [Public Suffix](https://publicsuffix.org/) part replaced by a wildcard.

Examples: `google.*` will apply to all similar Google domain names: `google.com`, `google.com.br`, `google.ca`, `google.co.uk`, etc. Another example: `facebook.*` will apply to all similar Facebook domain names: `facebook.com`, `facebook.net`.

Since the base domain name gets used to derive the name of the "entity", `google.evil.biz` would **not** match `google.*`.

Starting with [1.46.1b15](https://github.com/gorhill/uBlock/commit/81498474d6d440b032681aa9952d593749b39efb), you can use regex-based values as target domain (hostname) for static extended filters, works in base hostname, and also in filter options like: `domain=`, `to=` and `from=`. Examples of usage:

Solves: [regex-fied domain](https://github.com/uBlockOrigin/uBlock-issues/discussions/2234):

*   `/img[a-z]{3,5}\.buzz/##+js(nowoif)` - matches (example): `imgabcd.buzz`
*   `@@*$ghide,domain=/img[a-z]{3,4}\.buzz/` - matches (example): `imgabcd.buzz` in `domain=` filter option
*   `*$frame,from=plainlight.com,to=~/youtube/` - excludes domains containing word "youtube" in `to=` filter option

Solves: [Add support for domain double wildcarding in hiding rules (Would be a huge gamechanger for Nitter)](https://github.com/uBlockOrigin/uBlock-issues/issues/2905):

*   `/^nitter\.[^.]+\.[^.]+$/##.timeline-item:has-text(owned)` - matches (example): `nitter.abc.com`, but not `nitter.com` and not `nitter.abc.xyz.com`
*   `/^nitter(?:\.[^.]+){1,2}$/##.timeline-item:has-text(owned)` - matches (example): `nitter.com` + `nitter.abc.com`, but not `nitter.abc.xyz.com`

Solves: [Hiding rules are unable to specify to only block on the core domain and none of the subdomains (e.g. ~*.example.org doesn't work)](https://github.com/uBlockOrigin/uBlock-issues/issues/3291):

*   `/^example\.org$/##h1` - matches only `example.org` without subdomains
*   `/^www\.example\.org$/##h1` - matches only `www.example.org` without subdomains and without `example.org`
*   `/^(?:www\.)?example\.org$/##h1` - matches only `example.org` + `www.example.org` without subdomains
*   `/^example\.org$/,somesite.org,somesite2.*##h1` - can be combined with normal names and entities
*   `org,~/^example\.org$/##h1` - can be excluded (negated): matches `org` with all subdomains, without `example.org`, but still matches subdomains of `example.org` (for example `www.example.org`)

Use sparingly, when no other solution is practical from a maintenance point of view -- keeping in mind that uBO has to iterate through all the regex-based values, unlike plain hostname or entity-based values which are mere lookups.

New in [1.25.0](https://github.com/gorhill/uBlock/commit/3fab7bfdb4f892f3d33159fd53ccf1d5342a090a).

Related issue: [uBlockOrigin/uBlock-issues#803](https://github.com/uBlockOrigin/uBlock-issues/issues/803).

By preceding a typical generic cosmetic filter with a literal `*`, this can turn it into a specific-generic cosmetic filter that unconditionally gets injected into all web pages.

But a typical generic cosmetic filter would only inject when uBO's DOM surveyor finds at least one matching element in a web page.

The new specific-generic form will also be disabled when a web page is subject to a [`generichide`](#generichide) exception filter since the filter is essentially generic. The only difference from the usual generic form is that the filter is injected unconditionally instead of through the DOM surveyor.

Specific-generic cosmetic filters will NOT become discarded when checking the "Ignore generic cosmetic filters" option in the "Filter lists" pane since this option is primarily to disable the DOM surveyor.

For basic cosmetic filters you can refer to existing documentation from: Adblock Plus: "[element hiding filters](https://help.adblockplus.org/hc/en-us/articles/360062733293-How-to-write-filters#content-filters)", AdGuard:"[cosmetic rules](https://adguard.com/kb/general/ad-filtering/create-own-filters/#cosmetic-rule)", uBO Reddit FAQ:"[How to manually write cosmetic filter](https://www.reddit.com/r/uBlockOrigin/wiki/index/#wiki_how_to_manually_write_cosmetic_filter)".

#### Procedural cosmetic filters

[](#procedural-cosmetic-filters)

`:has(...)`, `:has-text(...)`, `:matches-attr(...)`, `:matches-css(...)`, `:matches-css-before(...)`, `:matches-css-after(...)`, `:matches-media(...)`, `:matches-path(...)`, `:matches-prop(...)`, `:min-text-length(n)`, `:not(...)`, `:others(...)`, `:upward(...)`, `:watch-attr(...)`, `:xpath(...)`.

See [detailed documentation](https://github.com/gorhill/uBlock/wiki/Procedural-cosmetic-filters).

By default, the implicit purpose of cosmetic filters is to hide unwanted DOM elements. However, it may be helpful to restyle a specific one or entirely remove it from the DOM tree.

*   Description: _action operator_, instruct to remove elements from the DOM tree instead of just hiding them.
*   Chainable: No, _action operator_ can only apply at the end of the root chain.
*   _subject_: Can be a plain CSS selector or a procedural cosmetic filter.
*   Examples:
    *   `gorhill.github.io###pcf #a18 .fail:remove()`

New in uBO [1.26.0](https://github.com/gorhill/uBlock/commit/72bb70056843024b1a31fe1ab9c90bd4e8260ba2). Fixes [#2252](https://github.com/gorhill/uBlock/issues/2252)

Since `:remove()` is an "action" operator, it must only be used as a trailing operator (just like the [`:style()` operator](#subjectstylearg)).

AG's cosmetic filter syntax `{ remove: true; }` will be converted to uBO's `:remove()` operator internally.

To remove elements from a document _before_ it is parsed by the browser, see: [`HTML filters`](#html-filters).

*   Description: _action operator_ applies a specified style to selected elements in the DOM tree.
*   Chainable: No, _action operator_ can only apply at the end of the root chain.
*   _subject_: Can be a plain CSS selector or a procedural cosmetic filter after [1.29.3b10](https://github.com/gorhill/uBlock/commit/35aefed92616cbfb75f12f37c7ea7fb3a3cc3369). Before, only native plain CSS selectors had support. See [#382](https://github.com/uBlockOrigin/uBlock-issues/issues/382).
*   _arg_: one or more [CSS property declarations](https://developer.mozilla.org/en-US/docs/Web/CSS/Syntax), separated by the standard `;`. Some characters, strings, and values are forbidden. See below for a list.
*   Examples:
    *   `example.com##h1:style(background-color: blue !important)`
    *   `motobanda.pl###mvideo:style(z-index: 1 !important)`

After [1.29.3b10](https://github.com/gorhill/uBlock/commit/35aefed92616cbfb75f12f37c7ea7fb3a3cc3369) procedural selectors are also supported.

Related issue: [Support cosmetic filters with explicit style properties](https://github.com/gorhill/uBlock/issues/781) and [example](https://github.com/uBlockOrigin/uAssets/issues/71#issuecomment-229503444) where it is useful.

It has the same syntax as plain cosmetic filters (it must be a valid CSS selector), except that the `:style(...)` suffix appends at the end. The content in the parentheses must be one or more [CSS property declarations](https://developer.mozilla.org/en-US/docs/Web/CSS/Syntax) (separated by the standard `;`). It is not allowed to use

*   property values with `url(...)`,
*   property values with `image-set(...)`,
*   comments (`/*`, `*/`),
*   backslashes (`\`-escaped values),
*   sequence of two forward slashes (`//`), even when separated by whitespace

Such `style`-based cosmetic filters will get discarded.

As with the other new cosmetic filtering selectors, `:style` can be used only for _specific_ cosmetic filters. A hostname or entity must get specified for the filter.

uBO can transparently convert and use the AG [CSS injection rules](https://kb.adguard.com/en/general/how-to-create-your-own-ad-filters#cosmetic-css-rules-syntax). This essentially means you can use AG's syntax in uBO if you prefer.

Styling filters frequently get used to foil anti-blocker mechanisms on web pages. To benefit from this, you may want to enable [AG's filter lists](https://kb.adguard.com/en/general/adguard-ad-filters) on the [3rd-party filters pane](https://github.com/gorhill/uBlock/wiki/Dashboard:-3rd-party-filters).

#### `subject:remove-attr(arg)`, `subject:remove-class(arg)`

[](#subjectremove-attrarg-subjectremove-classarg)

*   Description: _action operator_, instruct to remove attribute(s) or class(es) from DOM tree node(s) instead of just hiding them.
*   Chainable: No, _action operator_ can only apply at the end of the root chain.
*   _subject_: Can be a plain CSS selector or a procedural cosmetic filter.
*   _arg_: A plain string to match exactly, or a regex literal. Wrap _arg_ in quotes if the parser is having problem parsing _arg_, this can occur when using special characters.
*   Examples
    *   `userscloud.com##.btn-icon-stacked[onclick]:remove-attr(onclick)`
    *   `magesy.*,majesy.*##[oncontextmenu]:remove-attr(oncontextmenu)`
    *   `zerodot1.gitlab.io##selector:remove-attr(/oncontextmenu|onselectstart|ondragstart/)`
    *   `zerodot1.gitlab.io##selector:remove-attr(/^on[a-z]+/)`
    *   `danskebank.fi##html[cookie-consent-banner-open]:remove-class(cookie-consent-banner-open)`

New in uBO [1.45.3b13](https://github.com/gorhill/uBlock/commit/992255e9937f81b5dd58524caa2ceeaeb29efb14).

These two new pseudo selectors are _action_ operators, and thus can only be used at the end of a selector. They both take as argument a string or regex literal.

For `:remove-class()`, when the argument matches a class name, that class name is removed.

For `:remove-attr()`, when the argument matches an attribute name, that attribute is removed.

These operators are meant to replace `+js(remove-attr, ...)` and `+js(remove-class, ...)`, which from now on are candidate for deprecation in some future.

See also: [`:watch-attr()`](https://github.com/gorhill/uBlock/wiki/Procedural-cosmetic-filters#subjectwatch-attrarg) usage for cases when targeted attributes are added without DOM layout changes.

Supported by [uBO 1.15.0](https://github.com/gorhill/uBlock/releases/tag/1.15.0)+ in Firefox 57+.

**READ VERY CAREFULLY:** HTML filtering acts on the **response data** (before browser parsing). Do not use the browser inspector from developer tools to create HTML filters. You **must** use `view-source:[URL of page]` instead to look at the **response data** and find relevant information to create relevant HTML filters.

The purpose of HTML filters is to remove elements from a document _before_ it is parsed by the browser.

The syntax is similar to that of cosmetic filters, except that you must prefix your selector (CSS or procedural) with the character `^`:

```
example.com##^.badstuff
example.com##^script:has-text(7c9e3a5d51cdacfc)

```

These HTML filters will cause the elements matching the selectors to be **removed from the streamed response data**, such that the browser will never know of their existence once it parses the modified response data. It makes this a powerful tool in uBO's arsenal.

HTML filtering will work only on pages with character encoding compatible with: UTF-8, ISO-8859-1, Windows-1250, Windows-1251 and Windows-1252 ([detailed mapping](https://github.com/gorhill/uBlock/blob/2a91a685ce3d2dae5d3c285cff1bc74a1982be74/src/js/text-encode.js#L32)).

Starting with [1.48.5b4](https://github.com/gorhill/uBlock/commit/8507d637e5190836caec390fed3a9cff13b4e131), you can use negated hostnames in HTML filters. Example:

```
google.com,~translate.google.com##^script:has-text(consentCookiePayload)

```

Also see: [remove-node-text](https://github.com/gorhill/uBlock/wiki/Resources-Library#remove-node-textjs-)

Historical notes

*   With the introduction of HTML filtering, the `script:contains(...)` is now deprecated and internally converted into an equivalent `##^script:has-text(...)` HTML filter. The result is essentially the same: to prevent the execution of specific inline script tags in the main HTML document. See [_"Inline script tag filtering"_](https://github.com/gorhill/uBlock/wiki/Inline-script-tag-filtering) for further documentation.
*   Support for chaining procedural operators with native CSS selector syntax (i.e. `a:has(b) + c`) was added in [1.20.1b3](https://github.com/gorhill/uBlock/commit/41685f4cce084f3f89e9cdd8fc1cde5b57862958). Only procedural operators which make sense in the context of HTML filtering are supported.

### Response header filtering

[](#response-header-filtering)

New in [uBO 1.35.0](https://github.com/gorhill/uBlock/commit/f876b68171ff307f27601225607a6801f400437d).

The syntax to remove the response header is a special case of HTML filtering, whereas the response headers are targeted rather than the response body:

```
example.com##^responseheader(header-name)

```

`header-name` is required to be in lowercase. It is the name of the header to remove.

The removal of response headers can only be applied to document resources like main- or sub-frames.

Only a limited set of headers get targeted for removal:

*   `location`
*   `refresh`
*   `report-to`
*   `set-cookie`

This limitation ensures that uBO never lowers the security profile of web pages, as we wouldn't want to remove `content-security-policy`.

Given that the header removal occurs at onHeaderReceived time, this new ability works for all browsers.

The motivation for this new filtering ability is an instance of a website using a `refresh` header to redirect a visitor to an undesirable destination after a few seconds.

To filter network responses according to whether a **specific** response header is present and whether or not it matches a **distinct value**, see: [`header`](#header).

It allows the injection of specific JavaScript code into pages. The `...` part is a token identifying a JavaScript resource from the [resource library](https://github.com/gorhill/uBlock/wiki/Resources-Library). Keep in mind the resource library is under the control of the uBO project. Only JavaScript code vouched for by uBO is inserted into web pages through a valid resource token.

Some scriptlets support additional parameters when specified after the scriptlet name, separated by a comma. Commas, in these parameters, must be escaped. Before [1.22.0](https://github.com/gorhill/uBlock/commit/d67340f14db6ce5b446ef0ff4586b5e4d31f1086#diff-b03ba512faa0934947e57d28dc99b43bL242) this was possible only in regex literals (`/foo\x2Cbar\u002Cbaz/`), now backslash character is sufficient (`foo\,bar`).

Generic `+js` filters are ignored: those filters **must** be specific, i.e. they must apply to specific hostnames, e.g. `example.com##+js(nobab)` will inject [`bab-defuser`](https://github.com/gorhill/uBlock/wiki/Resources-Library#bab-defuserjs-) into pages on `example.com` domain.

Starting with [1.22.0](https://github.com/gorhill/uBlock/commit/bf3c92574e5f2386fe2abb4de779e782b0b5a1d2) new exception syntax has been added, allowing to wholly disable scriptlet injection for a given site without having to create exceptions for all matching scriptlet injection filters.

The following exception filter will cause scriptlet injection to be wholly disabled for `example.com`:

Or to disable scriptlet injection everywhere:

The following form is meaningless and ignored: