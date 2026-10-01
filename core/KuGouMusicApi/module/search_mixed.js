const { cryptoMd5 } = require('../util');
// 综合搜索 (混合搜索)
// 概念版(lite) 使用 AndroidFilter 参数，versionCode 为 201
// 标准版保留原 IOSFilter 参数
module.exports = (params, useAxios) => {
  const time = Date.now();
  const isLite = process.env.platform === 'lite';
  // complexsearch 现在强制要求 userid 参数，缺失时返回 error_code=152 Parameter Error
  const userid = params?.userid ?? params?.cookie?.userid ?? '0';
  // 兼容 keywords / keyword 两种写法：缺省时 keyword=undefined 会被计入 signature 但不发出，
  // 导致服务端校验签名失败（error_code=20006 err signature）。
  const keyword = params?.keywords || params?.keyword || '';

  const dataMap = isLite
    ? {
        keyword,
        userid,
        platform: 'AndroidFilter',
        tag: 'em',
        area_code: params?.area_code || 1,
        iscorrection: params?.iscorrection ?? 1,
        cursor: params?.cursor || 0,
        apiver: 22,
        osversion: '15',
        ability: 1,
        clientver: params?.clientver || 201,
        vip_status: params?.vip_status || params?.cookie?.vip_type || 0,
      }
    : {
        ab_tag: 0,
        ability: 511,
        albumhide: 0,
        apiver: 22,
        area_code: 1,
        clientver: params?.clientver || 20125,
        cursor: 0,
        is_gpay: 0,
        iscorrection: 1,
        keyword,
        userid,
        nocollect: 0,
        osversion: 16.5,
        platform: 'IOSFilter',
        recver: 2,
        req_ai: 1,
        requestid: `${cryptoMd5(`bdaa53d04e7475feb9024164a47032f9${time}`)}_0`,
        search_ability: 3,
        sec_aggre: 1,
        sec_aggre_bitmap: 0,
        style_type: 3,
        tag: 'em',
      };

  return useAxios({
    url: '/v3/search/mixed',
    method: 'GET',
    params: dataMap,
    encryptType: 'android',
    headers: { 'x-router': 'complexsearch.kugou.com', 'kg-clienttimems': time.toString() },
    cookie: params?.cookie || {},
  });
};
