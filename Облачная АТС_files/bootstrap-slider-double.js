/* =========================================================
 * bootstrap-slider.js v2.0.0
 * http://www.eyecon.ro/bootstrap-slider
 * =========================================================
 * Copyright 2012 Stefan Petre
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ========================================================= */
 
!function( $ ) {

	var DoubleSlider = function(element, options) {
		this.element = $(element);
		this.picker = $('<div class="slider">'+
							'<div class="slider-track">'+
								'<div class="slider-selection"></div>'+
								'<div class="slider-handle slider-handle_left"><span class="slider-button"></span><div class="slider-arrow"></div></div>'+
								'<div class="slider-handle slider-handle_right"><div class="slider-arrow"></div><span class="slider-button"></span></div>'+
							'</div>'+
							'<div class="tooltip"><div class="tooltip-arrow"></div><div class="tooltip-inner"></div></div>'+
						'</div>')
							.insertBefore(this.element)
							.append(this.element);
		this.id = this.element.data('slider-id')||options.id;
		if (this.id) {
			this.picker[0].id = this.id;
		}

		if (typeof Modernizr !== 'undefined' && Modernizr.touch) {
			this.touchCapable = true;
		}

		var tooltip = this.element.data('slider-tooltip')||options.tooltip;

		this.tooltip = this.picker.find('.tooltip');
		this.tooltipInner = this.tooltip.find('div.tooltip-inner');

		this.orientation = this.element.data('slider-orientation')||options.orientation;
		switch(this.orientation) {
			case 'vertical':
				this.picker.addClass('slider-vertical');
				this.stylePos = 'top';
				this.mousePos = 'pageY';
				this.sizePos = 'offsetHeight';
				this.tooltip.addClass('right')[0].style.left = '100%';
				break;
			default:
				this.picker
					.addClass('slider-horizontal')
					.css('width', this.element.outerWidth());
				this.orientation = 'horizontal';
				this.stylePos = 'left';
				this.mousePos = 'pageX';
				this.sizePos = 'offsetWidth';
				this.tooltip.addClass('top')[0].style.top = -this.tooltip.outerHeight() - 14 + 'px';
				break;
		}

		this.value = this.element.data('slider-value')||options.value;
		if (this.value[1]) {
			this.range = true;
		}

		this.selection = this.element.data('slider-selection')||options.selection;
		this.selectionEl = this.picker.find('.slider-selection');
		if (this.selection === 'none') {
			this.selectionEl.addClass('hide');
		}
		this.selectionElStyle = this.selectionEl[0].style;
                
                this.handle1 = this.picker.find('.slider-handle:first');
		this.handle1Stype = this.handle1[0].style;
                
		this.handle2 = this.picker.find('.slider-handle:last');
		this.handle2Stype = this.handle2[0].style;
                
                this.arrow1 = this.picker.find('.slider-arrow:first');
                this.arrow2 = this.picker.find('.slider-arrow:last');
                
                this.button1 = this.picker.find('.slider-button:first');
                this.button2 = this.picker.find('.slider-button:last');
                
                this.offset = this.picker.offset();
		this.size = this.picker[0][this.sizePos];
                
                this.handle1Size = this.handle1[0][this.sizePos];
                this.button1Size = this.button1[0][this.sizePos];
                this.arrow1Size = this.arrow1[0][this.sizePos];
                if (this.range){
                    this.handle2Size = this.handle2[0][this.sizePos];
                    this.button2Size = this.button2[0][this.sizePos];
                    this.arrow2Size = this.arrow2[0][this.sizePos] + (this.handle2Size - this.button2Size) / 2;
                }else{
                    this.handle2Size = 0;
                    this.button2Size = 0;
                    this.arrow2Size = 0;
                }
                
                this.step = this.element.data('slider-step')||options.step;
                
                this.handle1SizePercentage = (this.handle1Size * 100) / this.size;
                this.button1SizePercentage = (this.button1Size * 100) / this.size;
                this.arrow1SizePercentage = (this.arrow1Size * 100) / this.size;                
                this.handle2SizePercentage = (this.handle2Size * 100) / this.size;
                this.button2SizePercentage = (this.button2Size * 100 / this.size);
                this.arrow2SizePercentage = (this.arrow2Size * 100) / this.size;
                                
                this.max = this.element.data('slider-max')||options.max;
                this.min = this.element.data('slider-min')||options.min;
                this.maxSet = this.max;
                
                this.handle1Value = Math.round(((this.max - this.min) / 100 * this.handle1SizePercentage) / this.step) * this.step;
                this.button1Value = Math.round(((this.max - this.min) / 100 * this.button1SizePercentage) / this.step) * this.step;
                this.arrow1Value = Math.round(((this.max - this.min) / 100 * this.arrow1SizePercentage) / this.step) * this.step;
                this.handle2Value = Math.round(((this.max - this.min) / 100 * this.handle2SizePercentage) / this.step) * this.step;
                this.button2Value = Math.round(((this.max - this.min) / 100 * this.button1SizePercentage) / this.step) * this.step;
                this.arrow2Value = Math.round(((this.max - this.min) / 100 * this.arrow2SizePercentage) / this.step) * this.step;
                
                this.max = this.max + this.handle1Value + this.arrow1Value + this.arrow2Value;

		var handle = this.element.data('slider-handle')||options.handle;
		switch(handle) {
			case 'round':
				this.handle1.addClass('round');
				this.handle2.addClass('round');
				break
			case 'triangle':
				this.handle1.addClass('triangle');
				this.handle2.addClass('triangle');
				break
		}

		if (this.range) {
			this.value[0] = Math.max(this.min, Math.min(this.max, this.value[0]));
			this.value[1] = Math.max(this.min, Math.min(this.max, this.value[1]));
		} else {
			this.value = [ Math.max(this.min, Math.min(this.max, this.value))];
			this.handle2.addClass('hide');
			if (this.selection == 'after') {
				this.value[1] = this.max;
			} else {
				this.value[1] = this.min;
			}
		}
		this.diff = this.max - this.min;
		this.percentage = [
			(this.value[0]-this.min)*100/this.diff,
			(this.value[1]-this.min + this.handle1Value + this.arrow1Value + this.arrow2Value)*100/this.diff,
			this.step*100/this.diff
		];

		this.formater = options.formater;

		this.layout();

		if (this.touchCapable) {
			// Touch: Bind touch events:
			this.picker.on({
				touchstart: $.proxy(this.mousedown, this)
			});
		} else {
			this.picker.on({
				mousedown: $.proxy(this.mousedown, this)
			});
		}

		if (tooltip === 'show') {
			this.picker.on({
				mouseenter: $.proxy(this.showTooltip, this),
				mouseleave: $.proxy(this.hideTooltip, this)
			});
		} else {
			this.tooltip.addClass('hide');
		}
	};

	DoubleSlider.prototype = {
		constructor: DoubleSlider,

		over: false,
		inDrag: false,
		
		showTooltip: function(){
			this.tooltip.addClass('in');
			//var left = Math.round(this.percent*this.width);
			//this.tooltip.css('left', left - this.tooltip.outerWidth()/2);
			this.over = true;
		},
		
		hideTooltip: function(){
			if (this.inDrag === false) {
				this.tooltip.removeClass('in');
			}
			this.over = false;
		},

		layout: function(){
			this.handle1Stype[this.stylePos] = this.percentage[0]+'%';
			this.handle2Stype[this.stylePos] = this.percentage[1]+'%';
			if (this.orientation == 'vertical') {
				this.selectionElStyle.top = Math.min(this.percentage[0], this.percentage[1]) +'%';
				this.selectionElStyle.height = Math.abs(this.percentage[0] - this.percentage[1]) +'%';
			} else {
				this.selectionElStyle.left = Math.min(this.percentage[0], this.percentage[1]) +'%';
				this.selectionElStyle.width = Math.abs(this.percentage[0] - this.percentage[1]) +'%';
			}
			if (this.range) {
				this.tooltipInner.text(
					this.formater(this.value[0]) + 
					' : ' + 
					this.formater(this.value[1])
				);
				this.tooltip[0].style[this.stylePos] = this.size * (this.percentage[0] + (this.percentage[1] - this.percentage[0])/2)/100 - (this.orientation === 'vertical' ? this.tooltip.outerHeight()/2 : this.tooltip.outerWidth()/2) +'px';
			} else {
				this.tooltipInner.text(
					this.formater(this.value[0])
				);
				this.tooltip[0].style[this.stylePos] = this.size * this.percentage[0]/100 - (this.orientation === 'vertical' ? this.tooltip.outerHeight()/2 : this.tooltip.outerWidth()/2) +'px';
			}
		},

		mousedown: function(ev) {

			// Touch: Get the original event:
			if (this.touchCapable && ev.type === 'touchstart') {
				ev = ev.originalEvent;
			}

			this.offset = this.picker.offset();
			this.size = this.picker[0][this.sizePos];

			var percentage = this.getPercentage(ev);

			if (this.range) {
				var diff1 = Math.abs(this.percentage[0] - percentage);
				var diff2 = Math.abs(this.percentage[1] - percentage);
				this.dragged = (diff1 < diff2) ? 0 : 1;
			} else {
				this.dragged = 0;
			}
                        
                        if (this.dragged === 0){
                            if((percentage >= this.percentage[0] - (this.handle1SizePercentage - this.button1SizePercentage)) && (percentage <= this.percentage[0] + this.button1SizePercentage + this.arrow1SizePercentage)){
                                percentage = this.percentage[0];
                            }
                        } else if (this.dragged === 1){
                            if((percentage >= this.percentage[1] - this.arrow2SizePercentage) && (percentage <= this.percentage[1] + this.handle2SizePercentage)){
                                percentage = this.percentage[1];
                            }
                        }
                        
			this.percentage[this.dragged] = this.checkSlidersConnecting(percentage);
			this.layout();

			if (this.touchCapable) {
				// Touch: Bind touch events:
				$(document).on({
					touchmove: $.proxy(this.mousemove, this),
					touchend: $.proxy(this.mouseup, this)
				});
			} else {
				$(document).on({
					mousemove: $.proxy(this.mousemove, this),
					mouseup: $.proxy(this.mouseup, this)
				});
			}

			this.inDrag = true;
			var val = this.calculateValue();
			this.element.trigger({
					type: 'slideStart',
					value: val
				}).trigger({
					type: 'slide',
					value: val
				});
			return false;
		},

		mousemove: function(ev) {
			
			// Touch: Get the original event:
			if (this.touchCapable && ev.type === 'touchmove') {
				ev = ev.originalEvent;
			}

			var percentage = this.checkSlidersConnecting(this.getPercentage(ev)) ;
			this.percentage[this.dragged] = percentage;
			this.layout();
			var val = this.calculateValue();
			this.element
				.trigger({
					type: 'slide',
					value: val
				})
				.data('value', val)
				.prop('value', val);
			return false;
		},

		mouseup: function(ev) {
			if (this.touchCapable) {
				// Touch: Bind touch events:
				$(document).off({
					touchmove: this.mousemove,
					touchend: this.mouseup
				});
			} else {
				$(document).off({
					mousemove: this.mousemove,
					mouseup: this.mouseup
				});
			}

			this.inDrag = false;
			if (this.over == false) {
				this.hideTooltip();
			}
			this.element;
			var val = this.calculateValue();
			this.element
				.trigger({
					type: 'slideStop',
					value: val
				})
				.data('value', val)
				.prop('value', val);
			return false;
		},

		calculateValue: function() {
			var val;
			if (this.range) {
                            // TODO fix me
                                
                                var realPct = [
					this.percentage[0] * 100 / (100 - (this.button1SizePercentage + this.arrow1SizePercentage + this.arrow2SizePercentage + 1)),
					100 - ((100 - this.percentage[1]) * 100 / (100 - (this.button1SizePercentage + this.arrow1SizePercentage + this.arrow2SizePercentage + 1))),
                                ];
				val = [
					(this.min + Math.round(((this.maxSet - this.min) * realPct[0]/100)/this.step)*this.step),
					(this.min + Math.round(((this.maxSet - this.min) * realPct[1]/100)/this.step)*this.step)
					//(this.min + Math.round((this.diff * this.percentage[0]/100)/this.step)*this.step),
					//(this.min + Math.round((this.diff * this.percentage[1]/100)/this.step)*this.step) - this.handle1Value - this.arrow1Value -  this.arrow2Value
				];
				this.value = val;
			} else {
				val = (this.min + Math.round((this.diff * this.percentage[0]/100)/this.step)*this.step);
				this.value = [val, this.value[1]];
			}
			return val;
		},

		getPercentage: function(ev) {
			if (this.touchCapable) {
				ev = ev.touches[0];
			}
			var percentage = (ev[this.mousePos] - this.offset[this.stylePos])*100/this.size;
			percentage = Math.round(percentage/this.percentage[2])*this.percentage[2];
			return Math.max(0, Math.min(100, percentage));
		},
                
                                
                checkSlidersConnecting: function (percentage){
                    var result = percentage;
                    if (this.range) {
                        if (this.dragged === 0){
                            var max = this.percentage[1] - this.button1SizePercentage - this.arrow1SizePercentage - this.arrow2SizePercentage - 1;
                            if (result > max) {
                                result = max;
                            }
                        } else if (this.dragged === 1) {
                            var min = this.percentage[0] + this.button1SizePercentage + this.arrow1SizePercentage + this.arrow2SizePercentage + 1;
                            if(result < min){
                                result = min;
                            }
                        }
                    }
                    return result;
                },

		getValue: function() {
			if (this.range) {
				return this.value;
			}
			return this.value[0];
		},

		setValue: function(val) {
			this.value = val;

			if (this.range) {
				this.value[0] = Math.max(this.min, Math.min(this.max, this.value[0]));
				this.value[1] = Math.max(this.min, Math.min(this.max, this.value[1]));
			} else {
				this.value = [ Math.max(this.min, Math.min(this.max, this.value))];
				this.handle2.addClass('hide');
				if (this.selection == 'after') {
					this.value[1] = this.max;
				} else {
					this.value[1] = this.min;
				}
			}
			this.diff = this.max - this.min;
			this.percentage = [
				(this.value[0]-this.min)*100/this.diff,
				(this.value[1]-this.min + this.handle1Value + this.arrow1Value + this.arrow2Value)*100/this.diff,
				this.step*100/this.diff
			];
			this.layout();
		}
	};

	$.fn.doubleSlider = function ( option, val ) {
		return this.each(function () {
			var $this = $(this),
				data = $this.data('doubleSlider'),
				options = typeof option === 'object' && option;
			if (!data)  {
				$this.data('doubleSlider', (data = new DoubleSlider(this, $.extend({}, $.fn.doubleSlider.defaults,options))));
			}
			if (typeof option == 'string') {
				data[option](val);
			}
		})
	};

	$.fn.doubleSlider.defaults = {
		min: 0,
		max: 10,
		step: 1,
		orientation: 'horizontal',
		value: 5,
		selection: 'before',
		tooltip: 'show',
		handle: 'round',
		formater: function(value) {
			return value;
		}
	};

	$.fn.doubleSlider.Constructor = DoubleSlider;

}( window.jQuery );
