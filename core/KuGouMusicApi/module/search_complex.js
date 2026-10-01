// 综合搜索
module.exports = (params, useAxios) => {
  // complexsearch 现在强制要求 userid 参数，缺失时返回 error_code=152 Parameter Error
  const userid = params?.userid ?? params?.cookie?.userid ?? '0';
  const dataMap = {
    platform: 'AndroidFilter',
    keyword: params.keywords,
    userid,
    page: params?.page || 1,
    pagesize: params?.pagesize || 30,
    cursor: 0,
  };

  return useAxios({
    baseURL: 'https://complexsearch.kugou.com',
    url: '/v6/search/complex',
    method: 'GET',
    params: dataMap,
    encryptType: 'android',
    cookie: params?.cookie || {},
  });
};
