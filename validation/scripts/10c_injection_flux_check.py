"""Independent flux check of the injection path: inject AB 16 and 18 (no noise) into one real exposure, sum the added signal in a 6 px aperture, convert MJy/sr x pixel solid angle (8.890e-10 sr) to AB by hand. Run: uv run python scripts/10c_injection_flux_check.py"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import csv, numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from wp import inject
r=[x for x in csv.DictReader(open('data/index_barnard.csv')) if x['detector']=='2' and x['visit']=='0'][3]
h=fits.open(r['cutout_path']); img=(h[1].data-h[4].data).astype(float); var=h[3].data.astype(float); fl=h[2].data
w=WCS(h[1].header); x0y0=(h[0].header['X0'],h[0].header['Y0'])
ep=inject.get_epsf('barnard', r['obs_id'], 2)
x,y=150.3,170.6
ra,dec=w.pixel_to_world_values(x,y)
OM=8.890e-10
for mag in (16.0,18.0):
  fmjy=3631e-6*10**(-0.4*mag)  # by hand, MJy
  rng=np.random.default_rng(1)
  arr={'IMAGE':h[1].data.astype(float).copy(),'VARIANCE':var.copy(),'FLAGS':fl}
  out=inject.inject_point(arr,w,ra,dec,fmjy,ep,x0y0,rng,k=0.0)
  new=out[0]-h[4].data
  diff=new-img  # injected signal only (k=0 -> no noise)
  yy,xx=np.mgrid[:diff.shape[0],:diff.shape[1]]
  m=(xx-x)**2+(yy-y)**2<=6**2
  S=diff[m].sum()  # MJy/sr summed over pixels
  Fmjy=S*OM
  print('mag',mag,'injected MJy',fmjy,'recovered',Fmjy,'AB',-2.5*np.log10(Fmjy/3631e-6), 'omega used',inject.pixel_solid_angle_sr(w))

