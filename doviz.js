// We pick the time series being maintained by JHU folks on github.
//let rawTimeSeriesURL = "https://raw.githubusercontent.com/CSSEGISandData/COVID-19/master/csse_covid_19_data/csse_covid_19_time_series/time_series_covid19_confirmed_global.csv";

// The same as above, but via the rawgit CDN.
let rawTimeSeriesURL = "https://ghcdn.rawgit.org/CSSEGISandData/COVID-19/master/csse_covid_19_data/csse_covid_19_time_series/time_series_covid19_confirmed_global.csv";

// We convert the time series to a friendly structure that can
// be searched for country/province and the like. The return
// value is an array with the following props -
//
// result.timestamps = ["3/15/20", "3/16/20", ... ]
// result[i] = {province, country, lat, long, data}
// where data.length == result.timestamps.length
function asTimeSeries(data) {
    let lines = data.split('\n');
    let header = lines.shift(); // Drop the header.
    let columns = header.split(',');
    let result = lines.map((line) => {
        let cols = line.split(',');
        return {
            province: (cols[0] || '').trim(),
            country: (cols[1] || '').trim(),
            lat: +cols[2],
            long: +cols[3],
            data: cols.slice(4).map(n => +n)
        };
    });
    result.timestamps = columns.slice(4);
    return result;
}

// The JHU time series for confirmed cases in India has several anomalies
// around the April 6th time point, where one day's entry is given as 24 cases
// and another day's is given as 1200 whereas the govt sites and the WHO don't
// report those numbers. So we patch over the data from covid19india.org just for
// India alone.
//
// The covid19india argument is the JSON structure produced by https://api.covid19india.org/data.json
// The cases_time_series field is an array of records of the form  -
//
// { dailyconfirmed, dailydeceased, dailyrecovered, date: "06 April ", totalconfirmed, totaldeceased, totalrecovered }
//
// All values are text, so the numeric values will need to be converted from their string forms,
// But mainly the date needs to be translated to align with the JHU time series format.
// That job is done by wordDate2NumericDate() function below.
function patchIndiaData(timeSeries, covid19india) {
    timeSeries.forEach(line => {
        if (line.province === "" && line.country === "India") {
            //console.log("before patch", JSON.parse(JSON.stringify(line)));
            let cases = covid19india.cases_time_series;
            let tsmap = {};
            cases.forEach((c) => {
                tsmap[wordDate2NumericDate(c.date)] = c;
            });
            timeSeries.timestamps.forEach((tsa, i) => {
                let ts = tsa.trim();
                let c = tsmap[ts];
                if (c) {
                    //console.log(ts,"=>",+c.totalconfirmed);
                    line.data[i] = +c.totalconfirmed;
                } else {
                    // WARNING: The data point is not yet in. Leave the
                    // data as is from JHU data.
                    // console.log(ts,"=>",0);
                    // line.data[i] = 0;
                    console.error("India data point for timestamp " + tsa + " is not yet available. Using JHU data value of " + line.data[i] + ".");
                }
            });
            //console.log("after patch", JSON.parse(JSON.stringify(line)));
        }
    });
    return timeSeries;
}

const kMonthName2Number = {
    January: 1,
    February: 2,
    March: 3,
    April: 4,
    May: 5,
    June: 6,
    July: 7,
    August: 8,
    September: 9,
    October: 10,
    November: 11,
    December: 12
};

function wordDate2NumericDate(wdate) {
    let parts = wdate.split(/\s+/).map(s => s.trim());
    let result= kMonthName2Number[parts[1]] + '/' + (+parts[0]) + '/20';
    //console.log(wdate, "=>", result);
    return result;
}

// If data is a cumulative statistic, then the sliding window
// rate is ratio over the window geometrically divided over
// the window duration.
function sliding_window_rate(data, w) {
    return data.map((d,i) => Math.exp((Math.log(Math.max(1,d)) - Math.log(Math.max(1,(data[i-w]||0.0))))/w));
}

// Converts fractions to decimal with 3 significant figures.
function frac2pcnt(n) {
    return Math.round(1000*(n-1)) * 0.1;
}

// Returns a selector function that picks a country from the 
// dataset returned by asTimeSeries. Note that we need to check
// whether the province is an empty string. Otherwise the
// data can include regions within some countries.
function forCountry(c) {
    return s => s.province == '' && s.country == c;
}

const suffix_dbl = "_dbl";
const suffix_cum = "_cum";
const suffix_chg = "_chg";
const suffix_wow = "_wow";

// @param limit Gives the most recent N days in the time series to include.
// @param wind The window over which to average the rate. 5 is a good value.
// @param confirmed The timeseries structure returned by asTimeSeries()
// @param countries List of countries to include in the plot.
//
// Note: Doesn't check for "country not found" kind of errors.
// We're doing a fixed set.
function countrySeries(limit, wind, confirmed, ...countries) {
    let country_confirmed = countries.map(name => confirmed.filter(forCountry(name))[0]);
    let swc = countries.map((name,i) => sliding_window_rate(country_confirmed[i].data, wind).map(frac2pcnt));
    let weekonweek = countries.map((name,i) => {
        return country_confirmed[i].data.map((v,i,data) => {
            return (v - (data[i-7]||0)) / Math.max(1, (data[i-7]||0) - (data[i-14]||0));
        });
    });
    //console.log("week on week", weekonweek);
    let startIndex = confirmed.timestamps.length - limit;
    let date = confirmed.timestamps.slice(startIndex);
    let result = {date};

    countries.forEach((name, i) => {
        result[name] = swc[i].slice(startIndex);
        result[name + suffix_dbl] = country_confirmed[i].data.map(doubling_period).slice(startIndex);
        result[name + suffix_cum] = country_confirmed[i].data.slice(startIndex);
        result[name + suffix_chg] = country_confirmed[i].data.map((d,j,data) => d - (data[j-1]||0)).slice(startIndex);
        result[name + suffix_wow] = weekonweek[i].slice(startIndex);
    });

    //console.log("countries", result);
    return result;
}

function doubling_period(datum, i, series) {
    let period = 0;
    let target = datum * 0.5;
    for (let j = i; j >= 0; --j, ++period) {
        if (series[j] <= target) {
            return period;
        }
    }
    return -1; // Indicates not available.
}

// Utility to get data into Vega friendly form.
// Turns {a: [1,2,3,...], b: [10,20,30,...]}
// into [{a:1,b:10},{a:2,b:20},...]
function transpose(columnar) {
    let keys = Object.keys(columnar);
    let result = [];
    let N = columnar[keys[0]].length;
    for (let i = 0; i < N; ++i) {
        let row = {};
        for (let key of keys) {
            row[key] = columnar[key][i];
        }
        result.push(row);
    }
    //console.log("transpose", result);
    return result;
}

// Utility to get data into Vega friendly form.
// Turns multi-country table into a table with
// three columns - timeColumn, valueName and labelName.
// This structure is native to Vega-lite.
function multiplex(rows, timeColumn, valueName, labelName) {
    let result = [];
    let not_suffixed = (k) => {
        return (k !== timeColumn 
             && k.substring(k.length - suffix_wow.length) !== suffix_wow
             && k.substring(k.length - suffix_dbl.length) !== suffix_dbl
             && k.substring(k.length - suffix_cum.length) !== suffix_cum
             && k.substring(k.length - suffix_chg.length) !== suffix_chg);
    };
    let countries = Object.keys(rows[0]).filter(not_suffixed);
    for (let i = 0; i < rows.length; ++i) {
        let time = rows[i][timeColumn];
        for (let key of countries) {
            let obj = {};
            obj[timeColumn] = time;
            obj[valueName] = rows[i][key];
            obj[valueName + suffix_wow] = rows[i][key + suffix_wow];
            obj[valueName + suffix_dbl] = rows[i][key + suffix_dbl];
            obj[valueName + suffix_cum] = rows[i][key + suffix_cum];
            obj[valueName + suffix_chg] = rows[i][key + suffix_chg];
            obj[labelName] = key;
            result.push(obj);
        }
    }
    //console.log("multiplex", result);
    return result;
}

// Data is intended to be fetched only once. fetchData() takes care of fetching
// the data asynchronously. We therefore turn the availability of the data into
// a promise that any dependents can `await` on.
async function fetchData() {
    let receiver = await fetch(rawTimeSeriesURL);
    let csv = await receiver.text();
    let covid19india = await (await fetch("https://api.covid19india.org/data.json")).json();

    return patchIndiaData(asTimeSeries(csv), covid19india);
}

// Code that uses this global data_confirmed must do `await data_confirmed` it since it is
// a promise to produce the data.
const data_confirmed = fetchData();
const window_length = 5;

async function fetch_imaginea_json(url) {
   return await (await fetch("https://raw.githubusercontent.com/Imaginea/covid19/master/data/" + url + ".json")).json();
}
 

/****************** doviz functions **********************/

// Here we go ...
async function doviz() {
    let confirmed = await data_confirmed;
    let columnar = countrySeries(21, window_length, confirmed, "India", "US", "United Kingdom");
    let multiplexed = multiplex(transpose(columnar), "date", "d2dpcnt", "country");

    let spec = {
        width: 'container',
        //height: 'container',
        layer: [
            {
                data: {
                    values: multiplexed
                },
                selection: {
                    hover: {
                        type: "single",
                        on: "mouseover",
                        empty: "all",
                        fields: ["country"],
                        init: {country: "India"}
                    }
                },
                mark: { type: "line", point: { size: 70 } },
                transform: [
                    { calculate: "log(2)/log(1+datum.d2dpcnt/100)", as: "dbl", type: "quantitative" },
                    { calculate: "(datum.d2dpcnt > 0 ? '+' : '')+floor(datum.d2dpcnt)+'.'+(floor(datum.d2dpcnt*10)%10)+'%'", as: "pcnttext", type: "text" },
                    { calculate: "(datum.d2dpcnt_chg > 0 ? '+' : '')+datum.d2dpcnt_chg", as: "abschg", type: "text" },
                    { calculate: "''+(datum.d2dpcnt_dbl > 0 ? datum.d2dpcnt_dbl + ' days' : 'N/A')", as: "dblperiod", type: "text" },
                    //{ calculate: "'' + (datum.d2dpcnt_wow > 1 ? '+' : '') + round((datum.d2dpcnt_wow-1)*100) + '%'", as: "wowpcnt", type: "text" }
                    { calculate: "(datum.d2dpcnt_wow > 1 ? '+' : '')+floor((datum.d2dpcnt_wow-1)*100)+'%'", as: "wowpcnt", type: "text" }
                ],
                encoding: {
                    x: {field: "date", type: "temporal"},
                    y: {field: "dbl", type: "quantitative", title: '['+window_length+" day avg] Doubling period in days"},
                    tooltip: [
                        { field: "pcnttext", type: "nominal", title: '['+window_length+" day avg] D2D %" },
                        { field: "abschg", type: "nominal", title: "D2D change" },
                        { field: "dblperiod", type: "nominal", title: "Doubled in" },
                        { field: "wowpcnt", type: "nominal", title: "Weekly cases growth %" },
                        { field: "d2dpcnt" + suffix_cum, type: "quantitative", title: "Confirmed cases" }
                    ],
                    color: {
                        condition: { selection: "hover", field: "country", type: "nominal" },
                        value: "grey"
                    },
                    opacity: {
                        condition: { selection: "hover", value: 1 },
                        value: 0.2
                    },
                    strokeWidth: { condition: { selection: "hover", value: 3 }, value: 1 }
                }
            }]
    };

    vegaEmbed('#vis', spec);
}

async function doviz_rt_india() {
    let data = transpose(await fetch_imaginea_json("rt_india"));
    let spec = {
        width: 'container',
        height: 300,
        data: { values: data },
        //height: 'container',
        layer: [
            {
                mark: { type: "area", color: "gainsboro" },
                encoding: {
                    x: { field: "date", title: "Date", type: "temporal" },
                    y: { field: "p05", type: "quantitative" },
                    y2: { field: "p95", type: "quantitative" },
                    tooltip: [
                        { field: "date", title: "Date", type: "temporal" },
                        { field: "p05", title: "5%tile", type: "quantitative" },
                        { field: "rt", title: "Mean Rt", type: "quantitative" },
                        { field: "p95", title: "95%tile", type: "quantitative" },
                    { field: "daily_cases", title: "Cases", type: "quantitative" }
                    ]
                }
            },
            {
                mark: { type: "area", color: "silver" },
                encoding: {
                    x: { field: "date", title: "Date", type: "temporal" },
                    y: { field: "p25", type: "quantitative" },
                    y2: { field: "p75", type: "quantitative" },
                    tooltip: [
                        { field: "date", title: "Date", type: "temporal" },
                        { field: "p25", title: "25%tile", type: "quantitative" },
                        { field: "rt", title: "Mean Rt", type: "quantitative" },
                        { field: "p75", title: "75%tile", type: "quantitative" },
                    { field: "daily_cases", title: "Cases", type: "quantitative" }
                    ]
                }
            },
            {
                mark: { type: 'line', point: { size: 60, color: 'red' }, color: "red" },
                encoding: {
                    x: { field: "date", title: "Date", type: "temporal" },
                    y: { field: "rt", title: "Estimated Rt for India", type: "quantitative" },
                    tooltip: [
                        { field: "date", title: "Date", type: "temporal" },
                        { field: "rt", title: "Mean Rt", type: "quantitative" },
                    { field: "daily_cases", title: "Cases", type: "quantitative" }
                    ]

                }
            },
            {
                data: { values: [{y: 1.0}] },
                mark: { type: 'rule', color: "lime", size: 3 },
                encoding: {
                    y: { field: 'y', type: 'quantitative' }
                }
            },
            {
                data: { values: [{date: "25-Mar-20", label: "Lockdown", y: 0.4}, {date: "1-Sep-20", label: "Relaxation", y: 0.4}] },
                mark: { type: 'rule', color: "grey", size: 3 },
                encoding: {
                    x: { field: 'date', type: 'temporal' }
                }
            },
            {
                data: { values: [{date: "25-Mar-20", label: "Lockdown", y: 0.4}, {date: "1-Sep-20", label: "Relaxation", y: 0.4}] },
                mark: { type: 'text', dx: -30 },
                encoding: {
                    x: { field: 'date', type: 'temporal' },
                    y: { field: 'y', type: 'quantitative' },
                    text: { field: 'label' },
                    color: { value: 'grey' }
                }
            }                 
        ]
    };

    vegaEmbed('#vis_rt_india', spec);
}


// Here we go ...
async function doviz_rt_states_graph() {
    let data = await fetch_imaginea_json("rt_india_states");

    let spec = {
        width: 'container',
        //            height: 300,
        data: { values: data },
        facet: {
            column: {field: 'state_name', type: 'ordinal', sort: { op: 'max', field: 'rt', order: 'descending' }},

        },
        //height: 'container',
        spec: {
            layer: [
                {
                    mark: { type: "area", color: "gainsboro" },
                    encoding: {
                        x: { field: "date", title: "Date", type: "temporal" },
                        y: { field: "p05", type: "quantitative" },
                        y2: { field: "p95", type: "quantitative" },
                        tooltip: [
                            { field: "date", title: "Date", type: "temporal" },
                            { field: "p05", title: "5%tile", type: "quantitative" },
                            { field: "rt", title: "Est. Rt", type: "quantitative" },
                            { field: "p95", title: "95%tile", type: "quantitative" },
                        { field: "daily_cases", title: "Cases", type: "quantitative" }
                        ]
                    }
                },
                {
                    mark: { type: "area", color: "silver" },
                    encoding: {
                        x: { field: "date", title: "Date", type: "temporal" },
                        y: { field: "p25", type: "quantitative" },
                        y2: { field: "p75", type: "quantitative" },
                        tooltip: [
                            { field: "date", title: "Date", type: "temporal" },
                            { field: "p25", title: "25%tile", type: "quantitative" },
                            { field: "rt", title: "Est. Rt", type: "quantitative" },
                            { field: "p75", title: "75%tile", type: "quantitative" },
                        { field: "daily_cases", title: "Cases", type: "quantitative" }
                        ]
                    }
                },
                {
                    mark: { type: 'line', point: { size: 20, color: 'red' }, color: "red" },
                    encoding: {
                        x: { field: "date", title: "Date", type: "temporal" },
                        y: { field: "rt", title: "Estimated Rt", type: "quantitative" },
                        tooltip: [
                            { field: "date", title: "Date", type: "temporal" },
                            { field: "rt", title: "Est. Rt", type: "quantitative" },
                        { field: "daily_cases", title: "Cases", type: "quantitative" }
                        ]

                    }
                },
                {
                    data: { values: [{y: 1.0}] },
                    mark: { type: 'rule', color: "lime", size: 3 },
                    encoding: {
                        y: { field: 'y', type: 'quantitative' }
                    }
                }
            ]
        }
    };

    vegaEmbed('#vis_rt_states_graph', spec);
}

// Here we go ...
async function doviz_pcnt() {
    let confirmed = await data_confirmed;
    let columnar = countrySeries(20, window_length, confirmed, "India", "US", "United Kingdom");
    let multiplexed = multiplex(transpose(columnar), "date", "d2dpcnt", "country");

    let spec = {
        width: 'container',
        //height: 'container',
        layer: [
            {
                data: {
                    values: multiplexed
                },
                selection: {
                    hover: {
                        type: "single",
                        on: "mouseover",
                        empty: "all",
                        fields: ["country"],
                        init: {country: "India"}
                    }
                },
                mark: { type: "line", point: { size: 70 } },
                transform: [
                    { calculate: "(datum.d2dpcnt > 0 ? '+' : '')+floor(datum.d2dpcnt)+'.'+(floor(datum.d2dpcnt*10)%10)+'%'", as: "pcnttext", type: "text" },
                    { calculate: "(datum.d2dpcnt_chg > 0 ? '+' : '')+datum.d2dpcnt_chg", as: "abschg", type: "text" },
                    { calculate: "''+(datum.d2dpcnt_dbl > 0 ? datum.d2dpcnt_dbl + ' days' : 'N/A')", as: "dblperiod", type: "text" }
                ],
                encoding: {
                    x: {field: "date", type: "temporal"},
                    y: {field: "d2dpcnt", type: "quantitative", title: '['+window_length+" day avg] Day to day % change"},
                    tooltip: [
                        { field: "pcnttext", type: "nominal", title: '['+window_length+" day avg] D2D %" },
                        { field: "abschg", type: "nominal", title: "D2D change" },
                        { field: "dblperiod", type: "nominal", title: "Doubled in" },
                        { field: "d2dpcnt" + suffix_cum, type: "quantitative", title: "Confirmed cases" }
                    ],
                    color: {
                        condition: { selection: "hover", field: "country", type: "nominal" },
                        value: "grey"
                    },
                    opacity: {
                        condition: { selection: "hover", value: 1 },
                        value: 0.2
                    },
                    strokeWidth: { condition: { selection: "hover", value: 3 }, value: 1 }
                }
            }]
    };

    vegaEmbed('#vis_pcnt', spec);
}

// Here we go ...
async function doviz_rt() {
    let data = await fetch_imaginea_json("rt_daily_summary");

    let spec = {
        width: 'container',
        data: { values: data.states },
        //height: 'container',
        layer: [
            {
                mark: {
                    type: "errorbar",
                    color: "grey",
                    ticks: true
                },
                encoding: {
                    x: {
                        field: "p95",
                        type: "quantitative",
                        title: "Rt"
                    },
                    x2: {
                        field: "p05"
                    },
                    y: {
                        field: "state_name",
                        type: "ordinal",
                        title: "State",
                        sort: null
                    },
                    tooltip: [
                        { field: "state_name", type: "nominal", title: "State" },
                        { field: "p05", type: "quantitative", title: "5 %tile", format: ".2f" },
                        { field: "p95", type: "quantitative", title: "95 %tile", format: ".2f" }
                    ]
                }
            },
            {
                mark: {
                    type: "errorbar",
                    color: "crimson",
                    ticks: true
                },
                encoding: {
                    x: {
                        field: "p75",
                        type: "quantitative",
                        title: "Rt"
                    },
                    x2: {
                        field: "p25"
                    },
                    y: {
                        field: "state_name",
                        type: "ordinal",
                        title: "State",
                        sort: null
                    },
                    tooltip: [
                        { field: "state_name", type: "nominal", title: "State" },
                        { field: "p25", type: "quantitative", title: "25 %tile", format: ".2f" },
                        { field: "p75", type: "quantitative", title: "75 %tile", format: ".2f" }
                    ]                    
                }
            },                            
            {
                mark: {
                    type: "point",
                    filled: true,
                    color: "blue",
                    size: 50
                },
                encoding: {
                    x: {
                        field: "rt",
                        type: "quantitative"
                    },
                    y: {
                        field: "state_name",
                        type: "ordinal",
                        title: "State",
                        sort: null
                    },
                    tooltip: [
                        { field: "state_name", type: "nominal", title: "State" },
                        { field: "rt", type: "quantitative", title: "Mean Rt", format: ".2f" },
                        { field: "p05", type: "quantitative", title: "5 %tile", format: ".2f" },
                        { field: "p95", type: "quantitative", title: "95 %tile", format: ".2f" },
                        { field: "p25", type: "quantitative", title: "25 %tile", format: ".2f" },
                        { field: "p75", type: "quantitative", title: "75 %tile", format: ".2f" },

                    { field: "daily_cases", type: "quantitative", title: "Cases" },
                        { field: "date", type: "nominal", title: "Date" }
                    ]
                }
            },
            {
                data: { values: [{rt: 1.0}] },
                mark: { type: "rule", color: "darkgrey", size: 3 },
                encoding: {
                    x: { field: "rt", type: "quantitative" }
                }
            }
        ]
    };

    vegaEmbed('#vis_rt', spec);
}


