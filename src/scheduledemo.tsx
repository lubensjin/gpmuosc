import React, { useState, useMemo } from 'react';
import { Calculator, Info, ChevronDown, ChevronRight } from 'lucide-react';

const DB = {
  usage: [
    { id: 'office', name: '업무시설', spanX: 8.4, spanY: 8.4, height: 3.9 },
    { id: 'residential', name: '공동주택', spanX: 6.3, spanY: 6.3, height: 3.0 },
    { id: 'retail', name: '상업/리테일', spanX: 9.0, spanY: 9.0, height: 4.5 },
    { id: 'parking', name: '주차장', spanX: 7.8, spanY: 7.8, height: 3.0 }
  ],

  slabRule: [
    { minSpan: 0, maxSpan: 6.5, thickness: 0.15 },
    { minSpan: 6.5, maxSpan: 8.5, thickness: 0.18 },
    { minSpan: 8.5, maxSpan: 10.5, thickness: 0.22 }
  ],

  columnRule: [
    { minFloors: 1, maxFloors: 5, type: 'RC', size: 0.5 },
    { minFloors: 6, maxFloors: 15, type: 'RC', size: 0.6 },
    { minFloors: 16, maxFloors: 30, type: 'RC', size: 0.7 }
  ],

  beamRule: [
    { type: 'RC', minSpan: 0, maxSpan: 6.5, depth: 0.6, width: 0.3 },
    { type: 'RC', minSpan: 6.5, maxSpan: 8.5, depth: 0.7, width: 0.35 },
    { type: 'RC', minSpan: 8.5, maxSpan: 10.5, depth: 0.8, width: 0.4 }
  ],

  materialUnit: {
    slab_rebar: 120,
    column_rebar: 180,
    beam_rebar: 200
  },

  ground: [
    { type: 'rock', name: '암반', excFactor: 2.5, prod: 80 },
    { type: 'dense', name: '조밀', excFactor: 3.0, prod: 100 },
    { type: 'soft', name: '연약', excFactor: 3.5, prod: 80 },
    { type: 'very_soft', name: '매우 연약', excFactor: 4.0, prod: 60 }
  ],

  productivity: {
    excavation: 100,
    column_form: 80,
    column_rebar: 0.5,
    column_conc: 30,
    beam_form: 90,
    beam_conc: 35,
    slab_form: 100,
    slab_rebar: 120,
    slab_conc: 40,
    wall_form: 70,
    wall_conc: 35,
    masonry: 30,
    drywall: 60,
    tile: 25,
    stone: 20,
    flooring: 30,
    ceiling: 50,
    paint: 80,
    cw_frame: 50,
    cw_glass: 40,
    panel: 30,
    waterproof: 60,
    mep_rough: 70,
    mep_finish: 80,
    elevator: 15
  },

  earthworkConfig: {
    baseTeamSize: 10,
    soilDepthPerDay: {
      urban: 0.10,
      newtown: 0.15
    },
    rockDepthPerDay: {
      urban: 0.03,
      no_complaint: 0.045
    },
    siteTypes: [
      { id: 'urban', name: '도심지' },
      { id: 'newtown', name: '신도시/택지' },
      { id: 'no_complaint', name: '민원 적은 지역' }
    ]
  },

  retainingMethods: [
    { id: 'CIP', name: 'CIP+H-Pile', prodPerRig: 110, areaPerRig: 4000, setupDays: 10 },
    { id: 'SCW', name: 'SCW', prodPerRig: 175, areaPerRig: 6000, setupDays: 15 },
    { id: 'DWall', name: '지하연속벽', prodPerRig: 100, areaPerRig: 7500, setupDays: 20 }
  ],

  calendars: [
    { id: 'CAL0', name: 'Cal-0 표준', description: '365일/년, 설계/구매/콘크리트 양생 등', workRate: { seoul: 1.0, jeju: 1.0, busan: 1.0 } },
    { id: 'CAL1', name: 'Cal-1 외부공사', description: '토목공사, RC골조, 철골, 지붕공사 등', workRate: { seoul: 0.645, jeju: 0.651, busan: 0.68 } },
    { id: 'CAL2', name: 'Cal-2 지하/반실내', description: '지하 골조공사, 조적, 미장, 타일, 방수공사 등', workRate: { seoul: 0.708, jeju: 0.705, busan: 0.735 } },
    { id: 'CAL3', name: 'Cal-3 내부공사', description: '슬라브철, 내화피복, 실내마감공사 등', workRate: { seoul: 0.775, jeju: 0.814, busan: 0.812 } }
  ],

  regions: [
    { id: 'seoul', name: '서울' },
    { id: 'jeju', name: '제주' },
    { id: 'busan', name: '부산' }
  ]
};

const ConstructionScheduler = () => {
  const [mode, setMode] = useState('legal');
  const [showDetail, setShowDetail] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});

  const [inputs, setInputs] = useState({
    basementFloors: 3,
    groundFloors: 12,
    floorArea: 500,
    usage: 'office',
    structure: 'RC',
    ground: 'dense',
    workRate: 0.75,
    teamSize: 10,
    avgDepth: 12,
    rockRatio: 0.3,
    retainingMethod: 'CIP',
    siteType: 'urban',
    region: 'seoul',
    calendar_earthwork: 'CAL2',
    calendar_structure: 'CAL1',
    calendar_facade: 'CAL1',
    calendar_finish: 'CAL3'
  });

  const toggleGroup = (groupId) => {
    setExpandedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const getCalendarFactor = (calendarId) => {
    const cal = DB.calendars.find(c => c.id === calendarId);
    const region = inputs.region;
    if (!cal) return 1.0;
    return cal.workRate[region] || 1.0;
  };

  const getWorkRateForTrade = (trade) => {
    let calendarId = 'CAL0';
    if (trade === 'earthwork') calendarId = inputs.calendar_earthwork;
    if (trade === 'structure') calendarId = inputs.calendar_structure;
    if (trade === 'facade') calendarId = inputs.calendar_facade;
    if (trade === 'finish') calendarId = inputs.calendar_finish;
    return getCalendarFactor(calendarId);
  };

  const schedule = useMemo(() => {
    const {
      basementFloors, groundFloors, floorArea, usage,
      teamSize, avgDepth, rockRatio, retainingMethod, siteType
    } = inputs;

    const usageData = DB.usage.find(u => u.id === usage);
    const span = usageData.spanX;
    const nx = Math.max(1, Math.round(Math.sqrt(floorArea / (span * span))));
    const ny = Math.max(1, Math.round(floorArea / (nx * span * span)));

    const Lx = nx * span;
    const Ly = ny * span;
    const actualArea = Lx * Ly;

    const slabRule = DB.slabRule.find(r => span >= r.minSpan && span < r.maxSpan) || DB.slabRule[1];
    const columnRule = DB.columnRule.find(r => groundFloors >= r.minFloors && groundFloors <= r.maxFloors) || DB.columnRule[1];
    const beamRule = DB.beamRule.find(r => span >= r.minSpan && span < r.maxSpan) || DB.beamRule[1];

    const ts = slabRule.thickness;
    const colSize = columnRule.size;
    const beamDepth = beamRule.depth;
    const beamWidth = beamRule.width;

    const Ncol = (nx + 1) * (ny + 1);
    const Vcol = Ncol * colSize * colSize * usageData.height;
    const Wcol_rebar = Vcol * DB.materialUnit.column_rebar;
    const Acol_form = Ncol * 2 * (colSize + colSize) * usageData.height;

    const Lbeam_total = ((ny + 1) * nx + (nx + 1) * ny) * span;
    const Vbeam = Lbeam_total * beamWidth * beamDepth;
    const Wbeam_rebar = Vbeam * DB.materialUnit.beam_rebar;

    const Vslab = actualArea * ts;
    const Wslab_rebar = actualArea * DB.materialUnit.slab_rebar;

    const perimeterM = 2 * (Lx + Ly);

    let currentDay = 0;
    const tasks = [];

    const workRate_earth = getWorkRateForTrade('earthwork');
    const workRate_struct = getWorkRateForTrade('structure');
    const workRate_facade = getWorkRateForTrade('facade');
    const workRate_finish = getWorkRateForTrade('finish');

    // 토공사
    if (basementFloors > 0 && avgDepth > 0) {
      const earthworkTasks = [];
      
      const methodRule = DB.retainingMethods.find(m => m.id === retainingMethod) || DB.retainingMethods[0];
      const rigCount = Math.max(1, Math.round((actualArea * basementFloors) / methodRule.areaPerRig));
      const wallDailyProd = methodRule.prodPerRig * rigCount * workRate_earth;
      const wallQuantity = methodRule.id === 'DWall' ? perimeterM * avgDepth : perimeterM;
      const daysRetaining = Math.ceil(methodRule.setupDays + wallQuantity / wallDailyProd);

      earthworkTasks.push({
        id: 'earth_retaining',
        name: '흙막이 (' + methodRule.name + ')',
        start: currentDay,
        duration: daysRetaining,
        color: '#8B4513',
        details: {
          '공법': methodRule.name,
          '벽체 둘레': perimeterM.toFixed(1) + ' m',
          '평균 깊이': avgDepth.toFixed(1) + ' m',
          '총 물량': wallQuantity.toFixed(1) + (methodRule.id === 'DWall' ? ' m²' : ' m'),
          '장비 대수': rigCount + '대',
          '장비 생산성': methodRule.prodPerRig + (methodRule.id === 'DWall' ? ' m²/일' : ' m/일'),
          '세팅 기간': methodRule.setupDays + '일',
          '일 생산량': wallDailyProd.toFixed(1) + (methodRule.id === 'DWall' ? ' m²/일' : ' m/일'),
          '작업 가동률': (workRate_earth * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_earthwork).name + ')',
          '산정식': methodRule.setupDays + '일 + ' + wallQuantity.toFixed(0) + '÷' + wallDailyProd.toFixed(1) + ' = ' + daysRetaining + '일',
          '공기': daysRetaining + '일'
        }
      });
      currentDay += daysRetaining;

      const soilDepth = avgDepth * (1 - rockRatio);
      if (soilDepth > 0) {
        const cfg = DB.earthworkConfig;
        const depthPerDay = (cfg.soilDepthPerDay[siteType] || cfg.soilDepthPerDay.urban) * workRate_earth * (teamSize / cfg.baseTeamSize);
        const daysSoil = Math.ceil(soilDepth / depthPerDay);
        
        earthworkTasks.push({
          id: 'earth_soil',
          name: '토사 굴착',
          start: currentDay,
          duration: daysSoil,
          color: '#CD853F',
          details: {
            '부지 유형': DB.earthworkConfig.siteTypes.find(s => s.id === siteType).name,
            '토사 깊이': soilDepth.toFixed(2) + ' m',
            '토사 부피': (actualArea * soilDepth * basementFloors).toFixed(1) + ' m³',
            '층 면적': actualArea.toFixed(1) + ' m²',
            '지하 층수': basementFloors + '개층',
            '기준 깊이/일': (cfg.soilDepthPerDay[siteType] || cfg.soilDepthPerDay.urban).toFixed(3) + ' m/일',
            '장비 세트': (teamSize / cfg.baseTeamSize).toFixed(2) + ' 세트',
            '작업 가동률': (workRate_earth * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_earthwork).name + ')',
            '실제 깊이/일': depthPerDay.toFixed(3) + ' m/일',
            '산정식': soilDepth.toFixed(2) + 'm ÷ ' + depthPerDay.toFixed(3) + 'm/일 = ' + daysSoil + '일',
            '공기': daysSoil + '일'
          }
        });
        currentDay += daysSoil;
      }

      const rockDepth = avgDepth * rockRatio;
      if (rockDepth > 0) {
        const cfg = DB.earthworkConfig;
        const depthPerDay = cfg.rockDepthPerDay[siteType === 'no_complaint' ? 'no_complaint' : 'urban'] * workRate_earth * (teamSize / cfg.baseTeamSize);
        const daysRock = Math.ceil(rockDepth / depthPerDay);
        
        earthworkTasks.push({
          id: 'earth_rock',
          name: '암반 굴착',
          start: currentDay,
          duration: daysRock,
          color: '#A0522D',
          details: {
            '부지 유형': DB.earthworkConfig.siteTypes.find(s => s.id === siteType).name,
            '암반 깊이': rockDepth.toFixed(2) + ' m',
            '암반 부피': (actualArea * rockDepth * basementFloors).toFixed(1) + ' m³',
            '암반 비율': (rockRatio * 100).toFixed(0) + '%',
            '기준 깊이/일': cfg.rockDepthPerDay[siteType === 'no_complaint' ? 'no_complaint' : 'urban'].toFixed(3) + ' m/일',
            '장비 세트': (teamSize / cfg.baseTeamSize).toFixed(2) + ' 세트',
            '작업 가동률': (workRate_earth * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_earthwork).name + ')',
            '실제 깊이/일': depthPerDay.toFixed(3) + ' m/일',
            '산정식': rockDepth.toFixed(2) + 'm ÷ ' + depthPerDay.toFixed(3) + 'm/일 = ' + daysRock + '일',
            '공기': daysRock + '일'
          }
        });
        currentDay += daysRock;
      }

      tasks.push({
        id: 'earthwork_group',
        name: '토공사',
        isGroup: true,
        children: earthworkTasks,
        start: earthworkTasks[0].start,
        duration: currentDay - earthworkTasks[0].start,
        color: '#FF8C42'
      });
    }

    // 지하 골조
    if (basementFloors > 0) {
      const ugTasks = [];
      
      for (let i = basementFloors; i >= 1; i--) {
        const floorName = 'B' + i;
        
        const colDays = Math.ceil((Vcol / DB.productivity.column_conc / teamSize) / workRate_struct);
        ugTasks.push({
          id: 'ug_col_' + i,
          name: floorName + ' 기둥',
          start: currentDay,
          duration: colDays,
          color: '#708090',
          details: {
            '층': floorName,
            '그리드': nx + '×' + ny,
            '기둥 수': Ncol + '개 = (' + nx + '+1)×(' + ny + '+1)',
            '기둥 치수': (colSize*100).toFixed(0) + '×' + (colSize*100).toFixed(0) + ' cm',
            '층고': usageData.height + ' m',
            '콘크리트': Vcol.toFixed(2) + ' m³ = ' + Ncol + '개 × ' + (colSize*100).toFixed(0) + '×' + (colSize*100).toFixed(0) + '×' + (usageData.height*100).toFixed(0) + ' cm³',
            '철근': (Wcol_rebar/1000).toFixed(2) + ' ton = ' + Vcol.toFixed(2) + 'm³ × ' + DB.materialUnit.column_rebar + 'kg/m³',
            '거푸집': Acol_form.toFixed(1) + ' m²',
            '생산성': DB.productivity.column_conc + ' m³/팀/일',
            '투입 팀': teamSize + '팀',
            '작업 가동률': (workRate_struct * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_structure).name + ')',
            '산정식': Vcol.toFixed(2) + '÷(' + DB.productivity.column_conc + '×' + teamSize + ')÷' + workRate_struct.toFixed(3) + ' = ' + colDays + '일',
            '공기': colDays + '일'
          }
        });
        currentDay += colDays;
        
        const wallArea = perimeterM * usageData.height * 0.3;
        const wallDays = Math.ceil((wallArea / DB.productivity.wall_form / teamSize) / workRate_struct);
        ugTasks.push({
          id: 'ug_wall_' + i,
          name: floorName + ' 벽체',
          start: currentDay,
          duration: wallDays,
          color: '#778899',
          details: { '층': floorName, '공기': wallDays + '일' }
        });
        currentDay += wallDays;
        
        const beamDays = Math.ceil((Vbeam / DB.productivity.beam_conc / teamSize) / workRate_struct);
        ugTasks.push({
          id: 'ug_beam_' + i,
          name: floorName + ' 보',
          start: currentDay,
          duration: beamDays,
          color: '#A9A9A9',
          details: { '층': floorName, '공기': beamDays + '일' }
        });
        currentDay += beamDays;
        
        const slabDays = Math.ceil((Vslab / DB.productivity.slab_conc / teamSize) / workRate_struct);
        ugTasks.push({
          id: 'ug_slab_' + i,
          name: floorName + ' 슬라브',
          start: currentDay,
          duration: slabDays,
          color: '#C0C0C0',
          details: {
            '층': floorName,
            '면적': actualArea.toFixed(1) + ' m² = ' + Lx.toFixed(1) + '×' + Ly.toFixed(1) + 'm',
            '두께': (ts*100).toFixed(0) + ' cm',
            '콘크리트': Vslab.toFixed(2) + ' m³ = ' + actualArea.toFixed(1) + 'm² × ' + ts + 'm',
            '철근': (Wslab_rebar/1000).toFixed(2) + ' ton = ' + actualArea.toFixed(1) + 'm² × ' + DB.materialUnit.slab_rebar + 'kg/m²',
            '생산성': DB.productivity.slab_conc + ' m³/팀/일',
            '투입 팀': teamSize + '팀',
            '작업 가동률': (workRate_struct * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_structure).name + ')',
            '산정식': Vslab.toFixed(2) + '÷(' + DB.productivity.slab_conc + '×' + teamSize + ')÷' + workRate_struct.toFixed(3) + ' = ' + slabDays + '일',
            '공기': slabDays + '일'
          }
        });
        currentDay += slabDays;
      }
      
      tasks.push({
        id: 'ug_structure_group',
        name: '지하 골조',
        isGroup: true,
        children: ugTasks,
        start: ugTasks[0].start,
        duration: currentDay - ugTasks[0].start,
        color: '#A8DADC'
      });
    }

    // 지상 골조
    const superTasks = [];
    const superStart = currentDay;
    
    for (let i = 1; i <= groundFloors; i++) {
      const floorName = i + 'F';
      
      const colDays = Math.ceil((Vcol / DB.productivity.column_conc / teamSize) / workRate_struct);
      superTasks.push({
        id: 'super_col_' + i,
        name: floorName + ' 기둥',
        start: currentDay,
        duration: colDays,
        color: '#F4E285',
        details: {
          '층': floorName,
          '그리드': nx + '×' + ny + ' @ ' + span + 'm',
          '기둥 수': Ncol + '개 = (' + nx + '+1)×(' + ny + '+1)',
          '기둥 치수': (colSize*100).toFixed(0) + '×' + (colSize*100).toFixed(0) + ' cm',
          '층고': usageData.height + ' m',
          '콘크리트': Vcol.toFixed(2) + ' m³',
          '철근': (Wcol_rebar/1000).toFixed(2) + ' ton',
          '생산성': DB.productivity.column_conc + ' m³/팀/일',
          '투입 팀': teamSize + '팀',
          '작업 가동률': (workRate_struct * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_structure).name + ')',
          '산정식': Vcol.toFixed(2) + '÷(' + DB.productivity.column_conc + '×' + teamSize + ')÷' + workRate_struct.toFixed(3) + ' = ' + colDays + '일',
          '공기': colDays + '일'
        }
      });
      currentDay += colDays;
      
      const beamDays = Math.ceil((Vbeam / DB.productivity.beam_conc / teamSize) / workRate_struct);
      superTasks.push({
        id: 'super_beam_' + i,
        name: floorName + ' 보',
        start: currentDay,
        duration: beamDays,
        color: '#F4D03F',
        details: {
          '층': floorName,
          'X방향 보': ((ny + 1) * nx * span).toFixed(1) + ' m = (' + ny + '+1)×' + nx + '×' + span + 'm',
          'Y방향 보': ((nx + 1) * ny * span).toFixed(1) + ' m = (' + nx + '+1)×' + ny + '×' + span + 'm',
          '보 총길이': Lbeam_total.toFixed(1) + ' m',
          '보 치수': (beamWidth*100).toFixed(0) + '×' + (beamDepth*100).toFixed(0) + ' cm',
          '콘크리트': Vbeam.toFixed(2) + ' m³ = ' + Lbeam_total.toFixed(1) + '×' + beamWidth + '×' + beamDepth + 'm³',
          '생산성': DB.productivity.beam_conc + ' m³/팀/일',
          '작업 가동률': (workRate_struct * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_structure).name + ')',
          '산정식': Vbeam.toFixed(2) + '÷(' + DB.productivity.beam_conc + '×' + teamSize + ')÷' + workRate_struct.toFixed(3) + ' = ' + beamDays + '일',
          '공기': beamDays + '일'
        }
      });
      currentDay += beamDays;
      
      const slabDays = Math.ceil((Vslab / DB.productivity.slab_conc / teamSize) / workRate_struct);
      superTasks.push({
        id: 'super_slab_' + i,
        name: floorName + ' 슬라브',
        start: currentDay,
        duration: slabDays,
        color: '#F9E79F',
        details: {
          '층': floorName,
          '그리드': nx + '×' + ny + ' @ ' + span + 'm',
          '면적': actualArea.toFixed(1) + ' m² = ' + Lx.toFixed(1) + '×' + Ly.toFixed(1) + 'm',
          '두께': (ts*100).toFixed(0) + ' cm',
          '콘크리트': Vslab.toFixed(2) + ' m³ = ' + actualArea.toFixed(1) + '×' + ts + 'm³',
          '철근': (Wslab_rebar/1000).toFixed(2) + ' ton',
          '생산성': DB.productivity.slab_conc + ' m³/팀/일',
          '작업 가동률': (workRate_struct * 100).toFixed(1) + '% (' + DB.regions.find(r => r.id === inputs.region).name + ' ' + DB.calendars.find(c => c.id === inputs.calendar_structure).name + ')',
          '산정식': Vslab.toFixed(2) + '÷(' + DB.productivity.slab_conc + '×' + teamSize + ')÷' + workRate_struct.toFixed(3) + ' = ' + slabDays + '일',
          '공기': slabDays + '일'
        }
      });
      currentDay += slabDays;
    }
    
    tasks.push({
      id: 'super_structure_group',
      name: '지상 골조',
      isGroup: true,
      children: superTasks,
      start: superStart,
      duration: currentDay - superStart,
      color: '#F4E285'
    });

    // 외장 공사
    const facadeTasks = [];
    const facadeStartRate = mode === 'practical' ? 0.5 : 1.0;
    const facadeStart = superStart + (currentDay - superStart) * facadeStartRate;
    let facadeDay = facadeStart;
    
    const totalFacadeArea = perimeterM * usageData.height * groundFloors;
    
    const windowDays = Math.ceil((totalFacadeArea * 0.4 / DB.productivity.panel / teamSize) / workRate_facade);
    facadeTasks.push({
      id: 'facade_window',
      name: '외벽 창호 및 판넬',
      start: facadeDay,
      duration: windowDays,
      color: '#B19CD9',
      details: { '공기': windowDays + '일' }
    });
    facadeDay += windowDays;
    
    const cwFrameDays = Math.ceil((totalFacadeArea * 0.5 / DB.productivity.cw_frame / teamSize) / workRate_facade);
    facadeTasks.push({
      id: 'facade_cw_frame',
      name: '커튼월 프레임',
      start: facadeDay,
      duration: cwFrameDays,
      color: '#C8B6E2',
      details: { '공기': cwFrameDays + '일' }
    });
    facadeDay += cwFrameDays;
    
    const cwGlassDays = Math.ceil((totalFacadeArea * 0.5 / DB.productivity.cw_glass / teamSize) / workRate_facade);
    facadeTasks.push({
      id: 'facade_cw_glass',
      name: '커튼월 유리',
      start: facadeDay,
      duration: cwGlassDays,
      color: '#DDA0DD',
      details: { '공기': cwGlassDays + '일' }
    });
    facadeDay += cwGlassDays;
    
    const roofDays = Math.ceil((actualArea / DB.productivity.waterproof / teamSize) / workRate_facade);
    facadeTasks.push({
      id: 'facade_roof',
      name: '옥상 방수',
      start: facadeDay,
      duration: roofDays,
      color: '#F0A8D0',
      details: { '공기': roofDays + '일' }
    });
    
    tasks.push({
      id: 'facade_group',
      name: '외장 공사',
      isGroup: true,
      children: facadeTasks,
      start: facadeStart,
      duration: facadeDay - facadeStart + roofDays,
      color: '#C8B6E2'
    });

    // 내부 마감
    const finishTasks = [];
    const finishStartRate = mode === 'practical' ? 0.7 : 1.0;
    const finishStart = superStart + (currentDay - superStart) * finishStartRate;
    let finishDay = finishStart;
    
    const totalFinishArea = actualArea * groundFloors;
    
    const masonryDays = Math.ceil((totalFinishArea * 0.4 / DB.productivity.masonry / teamSize) / workRate_finish);
    finishTasks.push({
      id: 'finish_masonry',
      name: '조적/경량벽',
      start: finishDay,
      duration: masonryDays,
      color: '#B8D4B8',
      details: { '공기': masonryDays + '일' }
    });
    finishDay += masonryDays;
    
    const drywallDays = Math.ceil((totalFinishArea / DB.productivity.drywall / teamSize) / workRate_finish);
    finishTasks.push({
      id: 'finish_drywall',
      name: '석고보드',
      start: finishDay,
      duration: drywallDays,
      color: '#C9E4C9',
      details: { '공기': drywallDays + '일' }
    });
    finishDay += drywallDays;
    
    const tileDays = Math.ceil((totalFinishArea * 0.3 / DB.productivity.tile / teamSize) / workRate_finish);
    finishTasks.push({
      id: 'finish_tile',
      name: '타일',
      start: finishDay,
      duration: tileDays,
      color: '#A4D4AE',
      details: { '공기': tileDays + '일' }
    });
    finishDay += tileDays;
    
    const flooringDays = Math.ceil((totalFinishArea / DB.productivity.flooring / teamSize) / workRate_finish);
    finishTasks.push({
      id: 'finish_flooring',
      name: '바닥 마감',
      start: finishDay,
      duration: flooringDays,
      color: '#ADDFAD',
      details: { '공기': flooringDays + '일' }
    });
    finishDay += flooringDays;
    
    const ceilingDays = Math.ceil((totalFinishArea / DB.productivity.ceiling / teamSize) / workRate_finish);
    finishTasks.push({
      id: 'finish_ceiling',
      name: '천장',
      start: finishDay,
      duration: ceilingDays,
      color: '#98D8C8',
      details: { '공기': ceilingDays + '일' }
    });
    finishDay += ceilingDays;
    
    const paintDays = Math.ceil((totalFinishArea / DB.productivity.paint / teamSize) / workRate_finish);
    finishTasks.push({
      id: 'finish_paint',
      name: '도장',
      start: finishDay,
      duration: paintDays,
      color: '#7BC8A4',
      details: { '공기': paintDays + '일' }
    });
    finishDay += paintDays;
    
    tasks.push({
      id: 'finish_group',
      name: '내부 마감',
      isGroup: true,
      children: finishTasks,
      start: finishStart,
      duration: finishDay - finishStart,
      color: '#A4D4AE'
    });

    // 설비/전기
    const mepTasks = [];
    const mepStartRate = mode === 'practical' ? 0.6 : 0.8;
    const mepStart = superStart + (currentDay - superStart) * mepStartRate;
    let mepDay = mepStart;
    
    const mepRoughDays = Math.ceil((totalFinishArea / DB.productivity.mep_rough / teamSize) / workRate_finish);
    mepTasks.push({
      id: 'mep_rough',
      name: '배관 및 배선',
      start: mepDay,
      duration: mepRoughDays,
      color: '#FFB347',
      details: { '공기': mepRoughDays + '일' }
    });
    mepDay += mepRoughDays;
    
    const mepFinishDays = Math.ceil((totalFinishArea / DB.productivity.mep_finish / teamSize) / workRate_finish);
    mepTasks.push({
      id: 'mep_finish',
      name: '전기/설비 기구',
      start: mepDay,
      duration: mepFinishDays,
      color: '#FFCC99',
      details: { '공기': mepFinishDays + '일' }
    });
    mepDay += mepFinishDays;
    
    const elevatorDays = Math.ceil((groundFloors / DB.productivity.elevator / teamSize) / workRate_finish);
    mepTasks.push({
      id: 'mep_elevator',
      name: '승강기 설치',
      start: mepDay,
      duration: elevatorDays,
      color: '#FFD700',
      details: { '공기': elevatorDays + '일' }
    });
    
    tasks.push({
      id: 'mep_group',
      name: '설비/전기',
      isGroup: true,
      children: mepTasks,
      start: mepStart,
      duration: mepDay - mepStart + elevatorDays,
      color: '#FFB347'
    });

    const totalDays = Math.max(
      currentDay,
      facadeDay + roofDays,
      finishDay + paintDays,
      mepDay + elevatorDays
    );

    return { tasks, totalDays };
  }, [inputs, mode]);

  const renderGanttChart = () => {
    const { tasks, totalDays } = schedule;
    const pixelsPerDay = 2.5;
    const chartWidth = totalDays * pixelsPerDay;

    return (
      <div className="overflow-x-auto bg-white rounded-lg shadow">
        <div className="min-w-max p-6">
          <div className="flex mb-4" style={{ marginLeft: '240px' }}>
            {Array.from({ length: Math.max(1, Math.ceil(totalDays / 30)) }).map((_, i) => (
              <div key={i} style={{ width: 30 * pixelsPerDay + 'px' }} className="text-xs text-gray-600 border-l border-gray-300 pl-1">
                M{i + 1}
              </div>
            ))}
          </div>

          {tasks.map(task => (
            <div key={task.id}>
              <div className="flex items-center mb-2 cursor-pointer hover:bg-gray-50 rounded py-1" onClick={() => task.isGroup && toggleGroup(task.id)}>
                <div className="w-56 text-sm font-bold text-gray-800 pr-4 flex items-center gap-2">
                  {task.isGroup && (expandedGroups[task.id] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />)}
                  {task.name}
                </div>
                <div className="relative" style={{ width: chartWidth + 'px', height: '32px' }}>
                  <div className="absolute h-7 rounded" style={{
                    left: task.start * pixelsPerDay + 'px',
                    width: task.duration * pixelsPerDay + 'px',
                    backgroundColor: task.color,
                    top: '2px',
                    opacity: task.isGroup ? 0.3 : 1
                  }}>
                    {task.isGroup && <div className="text-xs text-gray-700 px-2 py-1 font-medium">{task.duration}일</div>}
                  </div>
                </div>
              </div>

              {task.isGroup && expandedGroups[task.id] && task.children && task.children.map(child => (
                <div key={child.id} className="flex items-center mb-1 ml-6 group">
                  <div className="w-48 text-xs text-gray-600 pr-4 truncate">{child.name}</div>
                  <div className="relative" style={{ width: chartWidth + 'px', height: '28px' }}>
                    <div className="absolute h-6 rounded cursor-pointer transition-all hover:opacity-80" style={{
                      left: child.start * pixelsPerDay + 'px',
                      width: child.duration * pixelsPerDay + 'px',
                      backgroundColor: child.color,
                      top: '2px'
                    }} onClick={() => setShowDetail(showDetail === child.id ? null : child.id)}>
                      <div className="flex items-center justify-between h-full px-2">
                        <span className="text-xs font-medium text-gray-800">{child.duration}일</span>
                        <Info className="w-3 h-3 opacity-60" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}

          <div className="mt-6 pt-4 border-t-2 border-gray-300">
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold text-gray-800">총 공기</span>
              <span className="text-2xl font-bold text-blue-600">
                {totalDays}일 ({Math.ceil(totalDays / 30)}개월)
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderDetails = () => {
    if (!showDetail) return null;

    let target = null;
    for (const t of schedule.tasks) {
      if (t.isGroup && t.children) {
        const found = t.children.find(c => c.id === showDetail);
        if (found) {
          target = found;
          break;
        }
      }
    }
    if (!target) return null;

    return (
      <div className="mt-6 bg-blue-50 rounded-lg p-6 border-2 border-blue-200">
        <div className="flex items-center gap-2 mb-4">
          <Calculator className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-bold text-gray-800">[{target.name}] 산정 근거</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Object.entries(target.details).map(([key, value]) => (
            <div key={key} className="bg-white rounded p-3 border border-blue-100">
              <div className="text-xs text-gray-500 mb-1">{key}</div>
              <div className="text-sm font-bold text-gray-800">{value}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-gray-50 min-h-screen">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Calculator className="w-8 h-8 text-blue-600" />
          <h1 className="text-3xl font-bold text-gray-800">건설 공정 스케줄러</h1>
        </div>
        <p className="text-gray-600">토공 상세 + 공종별 세분화 + 캘린더 반영</p>
      </div>

      <div className="mb-6 flex gap-3">
        <button
          onClick={() => setMode('legal')}
          className={'px-6 py-3 rounded-lg font-bold transition-all ' + (mode === 'legal' ? 'bg-blue-600 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-100')}
        >
          법정기준 (100% 완료 후 시작)
        </button>
        <button
          onClick={() => setMode('practical')}
          className={'px-6 py-3 rounded-lg font-bold transition-all ' + (mode === 'practical' ? 'bg-green-600 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-100')}
        >
          실무버전 (선행 50~70% 시 병행)
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-bold mb-4 text-gray-800">프로젝트 정보</h2>
        
        <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <h3 className="text-sm font-bold text-blue-800 mb-2">📍 지역 선택</h3>
          <div className="flex gap-3">
            {DB.regions.map(r => (
              <button
                key={r.id}
                onClick={() => setInputs(prev => ({ ...prev, region: r.id }))}
                className={'px-4 py-2 rounded-lg font-medium transition-all ' + 
                  (inputs.region === r.id ? 'bg-blue-600 text-white shadow-md' : 'bg-white text-gray-700 hover:bg-blue-100')}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">지하 층수</label>
            <input type="number" min={0} value={inputs.basementFloors}
              onChange={e => setInputs(prev => ({ ...prev, basementFloors: parseInt(e.target.value) || 0 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">지상 층수</label>
            <input type="number" min={1} value={inputs.groundFloors}
              onChange={e => setInputs(prev => ({ ...prev, groundFloors: parseInt(e.target.value) || 1 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">기준층 면적 (m²)</label>
            <input type="number" min={1} value={inputs.floorArea}
              onChange={e => setInputs(prev => ({ ...prev, floorArea: parseFloat(e.target.value) || 1 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">주 용도</label>
            <select value={inputs.usage} onChange={e => setInputs(prev => ({ ...prev, usage: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white">
              {DB.usage.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">평균 굴착 깊이 (m)</label>
            <input type="number" min={1} value={inputs.avgDepth}
              onChange={e => setInputs(prev => ({ ...prev, avgDepth: parseFloat(e.target.value) || 1 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">암반 비율 (0~1)</label>
            <input type="number" min={0} max={1} step={0.05} value={inputs.rockRatio}
              onChange={e => setInputs(prev => ({ ...prev, rockRatio: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">흙막이 공법</label>
            <select value={inputs.retainingMethod} onChange={e => setInputs(prev => ({ ...prev, retainingMethod: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white">
              {DB.retainingMethods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">부지 유형</label>
            <select value={inputs.siteType} onChange={e => setInputs(prev => ({ ...prev, siteType: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white">
              {DB.earthworkConfig.siteTypes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">투입 팀 수</label>
            <input type="number" min={1} value={inputs.teamSize}
              onChange={e => setInputs(prev => ({ ...prev, teamSize: parseInt(e.target.value) || 1 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
        </div>

        <h3 className="text-lg font-bold mb-3 text-gray-800">📅 공종별 캘린더 설정</h3>
        <p className="text-xs text-gray-500 mb-3">각 공종에 적합한 캘린더를 선택하세요. 지역별 작업 가동률이 자동 반영됩니다.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-bold text-gray-800 mb-2">🏗️ 토공사</label>
            <select value={inputs.calendar_earthwork} onChange={e => setInputs(prev => ({ ...prev, calendar_earthwork: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm mb-2">
              {DB.calendars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="text-xs text-gray-600">
              {DB.calendars.find(c => c.id === inputs.calendar_earthwork)?.description}
              <div className="mt-1 font-bold text-blue-600">
                {DB.regions.find(r => r.id === inputs.region)?.name} 가동률: {(getCalendarFactor(inputs.calendar_earthwork) * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-bold text-gray-800 mb-2">🏢 골조공사</label>
            <select value={inputs.calendar_structure} onChange={e => setInputs(prev => ({ ...prev, calendar_structure: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm mb-2">
              {DB.calendars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="text-xs text-gray-600">
              {DB.calendars.find(c => c.id === inputs.calendar_structure)?.description}
              <div className="mt-1 font-bold text-blue-600">
                {DB.regions.find(r => r.id === inputs.region)?.name} 가동률: {(getCalendarFactor(inputs.calendar_structure) * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-bold text-gray-800 mb-2">🪟 외장공사</label>
            <select value={inputs.calendar_facade} onChange={e => setInputs(prev => ({ ...prev, calendar_facade: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm mb-2">
              {DB.calendars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="text-xs text-gray-600">
              {DB.calendars.find(c => c.id === inputs.calendar_facade)?.description}
              <div className="mt-1 font-bold text-blue-600">
                {DB.regions.find(r => r.id === inputs.region)?.name} 가동률: {(getCalendarFactor(inputs.calendar_facade) * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-bold text-gray-800 mb-2">🎨 내부마감</label>
            <select value={inputs.calendar_finish} onChange={e => setInputs(prev => ({ ...prev, calendar_finish: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm mb-2">
              {DB.calendars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="text-xs text-gray-600">
              {DB.calendars.find(c => c.id === inputs.calendar_finish)?.description}
              <div className="mt-1 font-bold text-blue-600">
                {DB.regions.find(r => r.id === inputs.region)?.name} 가동률: {(getCalendarFactor(inputs.calendar_finish) * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {renderGanttChart()}
      {renderDetails()}

      <div className="mt-6 text-sm text-gray-500 text-center">
        💡 그룹명 클릭: 세부 작업 펼치기 • 작업 바 클릭: 산정 근거 보기
      </div>
    </div>
  );
};

export default ConstructionScheduler;