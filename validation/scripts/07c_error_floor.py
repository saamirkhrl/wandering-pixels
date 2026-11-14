"""Phase B z widths with and without the 2 percent error floor (Barnard). One command: uv run python scripts/07c_error_floor.py"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import numpy as np, csv, collections
from astropy.table import Table
from wp.phaseb import spec_model, VISIT_PAIRS
rs=lambda x:1.4826*np.median(np.abs(x-np.median(x)))
rng=np.random.default_rng(3)
from wp.results import update_results, metric
RES={}
def boot(z,sid,n=300):
  us=np.unique(sid); idx={u:np.where(sid==u)[0] for u in us}
  return np.std([rs(z[np.concatenate([idx[u] for u in rng.choice(us,len(us))])]) for _ in range(n)])
f='barnard'
t=Table.read(f'data/phaseb/{f}/forced_phot.ecsv'); t=t[t['ok']]
for floor in (0.0,0.02):
  out={'P1native':[], 'M2one':[], 'PS':[]}; sids={k:[] for k in out}
  for (a,b,c) in VISIT_PAIRS[f]:
    for d in range(1,7):
      A=t[(t['visit']==a)&(t['detector']==d)]; B=t[(t['visit']==b)&(t['detector']==d)]
      for s in np.unique(A['source_id']):
        x=A[A['source_id']==s]; y=B[B['source_id']==s]
        if len(y)<3 or len(x)<3: continue
        vx=np.array(x['var'])+(floor*np.array(x['flux']))**2; vy=np.array(y['var'])+(floor*np.array(y['flux']))**2
        fx=np.array(x['flux']); fy=np.array(y['flux']); lx=np.array(x['lam']); ly=np.array(y['lam']); bx=np.array(x['bw']); by=np.array(y['bw'])
        for i in range(len(x)):
          # P1native-like: nearest lambda at star (approximation of field-centre rule)
          j=np.argmin(abs(ly-lx[i])); out['P1native'].append((fx[i]-fy[j])/np.sqrt(vx[i]+vy[j])); sids['P1native'].append(s)
          ma,va,_=spec_model(lx[:,None],fx[:,None],vx[:,None],lx[i],bx[i]); mb,vb,_=spec_model(ly[:,None],fy[:,None],vy[:,None],lx[i],bx[i])
          if np.isfinite(ma[0]) and np.isfinite(mb[0]): out['M2one'].append((ma[0]-mb[0])/np.sqrt(va[0]+vb[0])); sids['M2one'].append(s)
        # PS tol 1
        c_=sorted([(abs(lx[i]-ly[j])/(0.5*(bx[i]+by[j])),abs(x['mjd'][i]-y['mjd'][j]),i,j) for i in range(len(x)) for j in range(len(y))])
        ui=set();uj=set();dd=[];vv=[]
        for g,_,i,j in c_:
          if g>1 or i in ui or j in uj: continue
          ui.add(i);uj.add(j);dd.append(fx[i]-fy[j]);vv.append(vx[i]+vy[j])
        if dd:
          w=1/np.array(vv); out['PS'].append(np.sum(w*dd)/np.sqrt(w.sum())); sids['PS'].append(s)
  for k in out:
    z=np.array(out[k]); e=boot(z,np.array(sids[k])); print(f, 'floor',floor,k,len(z), f'{rs(z):.2f}+-{e:.2f}')
    RES[f'{k}_floor{floor}']=metric(float(rs(z)),'z width',n=len(z),script='07c_error_floor.py',note=f'bootstrap err {e:.3f}')
# P2 with floor/N
p2=Table.read(f'data/phaseb/{f}/fluxes_P2.ecsv')
idx=list(csv.DictReader(open(f'data/index_{f}.csv'))); N=collections.Counter((int(r['visit']),int(r['detector'])) for r in idx if r['on_detector']=='True')
for floor in (0.0,0.02):
  nA=np.array([N[(int(r['visitA']),int(r['detector']))] for r in p2]); nB=np.array([N[(int(r['visitB']),int(r['detector']))] for r in p2])
  z=(p2['F_A']-p2['F_B'])/np.sqrt(p2['var_A']+p2['var_B']+(floor*p2['F_A'])**2/nA+(floor*p2['F_B'])**2/nB)
  e=boot(np.array(z),np.array(p2['source_id'])); print(f,'floor',floor,'P2',len(z),f'{rs(np.array(z)):.2f}+-{e:.2f}')
  RES[f'P2_floor{floor}']=metric(float(rs(np.array(z))),'z width',n=len(z),script='07c_error_floor.py',note=f'bootstrap err {e:.3f}; floor divided by exposures per stack')
update_results('phaseb_error_floor_barnard',RES)
